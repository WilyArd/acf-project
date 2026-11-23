import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config/index.js';
import { createProxyRoutes, type ProxyRoutesOptions } from './api/proxy.routes.js';

export interface BuildAppOptions extends ProxyRoutesOptions {
  logger?: boolean;
}

/**
 * Build the Fastify instance without listening, so tests can drive it via `inject()`.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const loggerConfig = options.logger
    ? {
        redact: {
          paths: ['req.headers.authorization', 'req.headers["x-proxy-key"]'],
          censor: '[REDACTED]',
        },
      }
    : false;

  const app = Fastify({
    logger: loggerConfig,
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.FASTIFY_BODY_LIMIT_BYTES,
  });

  app.server.requestTimeout = 30_000;
  app.server.headersTimeout = 10_000;
  app.server.keepAliveTimeout = 5_000;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const code = (error as { code?: string }).code;

    // Fastify parses the body before the handler: remap its parser errors to docs/03 §4.
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(400).send({
        error: {
          code: 'REQUEST_BODY_TOO_LARGE',
          message: 'Ukuran request body melebihi batas 1MB.',
          field: 'request.body',
        },
      });
    }

    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.code(400).send({
        error: {
          code: 'INVALID_JSON_BODY',
          message: 'Request body bukan JSON yang valid.',
          field: 'request.body',
        },
      });
    }

    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(400).send({
        error: {
          code: 'INVALID_JSON_BODY',
          message: 'Content-Type request harus application/json.',
          field: 'request.body',
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan internal.', field: null },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.', field: null },
    });
  });

  await app.register(createProxyRoutes(options), { prefix: '' });
  return app;
}

export { config };
