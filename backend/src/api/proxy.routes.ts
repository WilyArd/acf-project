import crypto from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/index.js';
import { evaluate } from '../core/assertion/evaluate.js';
import type { ErrorPayload, ResultPayload, ValidationError } from '../models/types.js';
import { RateLimiter } from '../services/rateLimiter.js';
import { checkTarget, type SsrfOptions } from '../services/ssrfGuard.js';
import { dispatch } from '../services/dispatcher.js';
import {
  appendQueryParams,
  asExecutePayload,
  sanitizeHeaders,
  validatePayload,
} from '../services/validator.js';

export interface ProxyRoutesOptions {
  rateLimiter?: RateLimiter;
  ssrf?: Pick<SsrfOptions, 'lookup'>;
  dispatcher?: typeof dispatch;
  /** Overrides config.ALLOW_LOCAL_TARGETS; tests set this per instance. */
  allowLocalTargets?: boolean;
  /** Optional proxy access key override (defaults to config.PROXY_API_KEY). */
  proxyApiKey?: string;
  /** Optional max concurrent requests override. */
  maxInFlight?: number;
}

function sendValidationError(reply: FastifyReply, error: ValidationError, status: number): FastifyReply {
  return reply.code(status).send({ error });
}

function errorStatus(code: ValidationError['code']): number {
  if (code === 'RATE_LIMIT_EXCEEDED') return 429;
  if (code === 'LOCAL_TARGET_BLOCKED') return 403;
  return 400;
}

function timingSafeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createProxyRoutes(options: ProxyRoutesOptions = {}): FastifyPluginAsync {
  const limiter =
    options.rateLimiter ??
    new RateLimiter({ max: config.RATE_LIMIT_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS });
  const runDispatch = options.dispatcher ?? dispatch;
  const requiredApiKey = options.proxyApiKey ?? config.PROXY_API_KEY;
  const maxInFlight = options.maxInFlight ?? config.MAX_IN_FLIGHT_REQUESTS;
  const rawBytesMap = new WeakMap<FastifyRequest, number>();
  let inFlightCount = 0;

  return async (app: FastifyInstance) => {
    app.post(
      '/api/proxy/execute',
      {
        onRequest: async (request, reply) => {
          // 1a. Optional Proxy API Key gate before rate limit / body parse
          if (requiredApiKey !== '') {
            const rawHeader = request.headers['x-proxy-key'];
            const provided = typeof rawHeader === 'string' ? rawHeader : '';
            if (!timingSafeMatch(provided, requiredApiKey)) {
              return reply.code(401).send({
                error: {
                  code: 'UNAUTHORIZED',
                  message: 'Kunci akses proxy tidak valid atau tidak disertakan.',
                  field: null,
                },
              });
            }
          }

          // 1b. Rate limit BEFORE JSON body parsing (docs/04 §3)
          if (!limiter.check(request.ip)) {
            return sendValidationError(
              reply,
              {
                code: 'RATE_LIMIT_EXCEEDED',
                message: `Terlalu banyak request. Maksimum ${config.RATE_LIMIT_MAX} request per menit.`,
                field: null,
              },
              429,
            );
          }

          // 1c. Global concurrency cap against slowloris/fan-out exhaustion
          if (inFlightCount >= maxInFlight) {
            return sendValidationError(
              reply,
              {
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Server sedang menangani terlalu banyak request bersamaan. Coba lagi sebentar.',
                field: null,
              },
              429,
            );
          }
        },
        preParsing: async (request, _reply, payload) => {
          let total = 0;
          payload.on('data', (chunk: Buffer | string) => {
            total += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
            rawBytesMap.set(request, total);
          });
          return payload;
        },
      },
      async (request, reply) => {
        inFlightCount += 1;
        const disconnectController = new AbortController();
        const onReplyClose = () => {
          if (!reply.raw.writableEnded) {
            disconnectController.abort();
          }
        };
        reply.raw.once('close', onReplyClose);

        try {
          const measuredBytes =
            rawBytesMap.get(request) ??
            Number.parseInt(String(request.headers['content-length'] ?? '0'), 10);
          const rawBytes = Number.isFinite(measuredBytes) && measuredBytes > 0 ? measuredBytes : 0;

          const validationError = validatePayload(rawBytes, request.body);
          if (validationError) {
            return sendValidationError(reply, validationError, errorStatus(validationError.code));
          }

          const payload = asExecutePayload(request.body);
          const { method, url, headers, queryParams, body } = payload.request;

          const targetUrl = new URL(appendQueryParams(url, queryParams));
          const executedAt = new Date().toISOString();

          // 2. DNS resolve + SSRF policy
          const startedAt = performance.now();
          const ssrfOutcome = await checkTarget(targetUrl, {
            allowLocalTargets: options.allowLocalTargets ?? config.ALLOW_LOCAL_TARGETS,
            ...(options.ssrf?.lookup ? { lookup: options.ssrf.lookup } : {}),
          });

          if (ssrfOutcome.kind === 'blocked') {
            return sendValidationError(
              reply,
              {
                code: 'LOCAL_TARGET_BLOCKED',
                message: 'Target mengarah ke alamat IP internal/privat dan diblokir.',
                field: 'request.url',
              },
              403,
            );
          }

          if (ssrfOutcome.kind === 'dns-failed') {
            // No validation code exists for an unresolvable host: it is an ERROR (docs/04 §3).
            const payloadError: ErrorPayload = {
              overallStatus: 'ERROR',
              totalAssertions: 0,
              passedCount: 0,
              failedCount: 0,
              executedAt,
              errorReason: ssrfOutcome.reason,
              assertionDetails: [],
              rawResponse: null,
            };
            return reply.code(200).send(payloadError);
          }

          // 3. Dispatch with pinned resolved IPs & disconnect abort signal
          const dispatchTarget = {
            method,
            url: targetUrl.toString(),
            headers: buildOutboundHeaders(method, headers, body),
            resolvedAddresses: ssrfOutcome.addresses,
            ...(body === undefined || body === null || method === 'GET'
              ? {}
              : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
          };

          const outcome = await runDispatch(dispatchTarget, {
            timeoutMs: config.OUTBOUND_TIMEOUT_MS,
            responseLimitBytes: config.RESPONSE_LIMIT_BYTES,
            signal: disconnectController.signal,
          });

          if (outcome.kind === 'error') {
            const payloadError: ErrorPayload = {
              overallStatus: 'ERROR',
              totalAssertions: 0,
              passedCount: 0,
              failedCount: 0,
              executedAt,
              errorReason: outcome.reason,
              assertionDetails: [],
              rawResponse: null,
            };
            return reply.code(200).send(payloadError);
          }

          const response = {
            ...outcome.response,
            responseTimeMs: Math.round(performance.now() - startedAt),
          };

          // 4. Evaluate (pure)
          const verdict = evaluate(response, payload.assertions);

          const result: ResultPayload = {
            overallStatus: verdict.overallStatus,
            totalAssertions: verdict.totalAssertions,
            passedCount: verdict.passedCount,
            failedCount: verdict.failedCount,
            executedAt,
            assertionDetails: verdict.assertionDetails,
            rawResponse: {
              statusCode: response.statusCode,
              responseTimeMs: response.responseTimeMs,
              bodySizeBytes: response.bodySizeBytes,
              truncated: response.truncated,
              headers: response.headers,
              body: response.body,
            },
          };
          return reply.code(200).send(result);
        } finally {
          inFlightCount = Math.max(0, inFlightCount - 1);
          reply.raw.removeListener('close', onReplyClose);
        }
      },
    );
  };
}

/**
 * GET ignores the body and gets no automatic Content-Type. Methods that send a body
 * receive `application/json` only when the user did not set Content-Type themselves.
 */
function buildOutboundHeaders(
  method: string,
  headers: Record<string, string>,
  body: unknown,
): Record<string, string> {
  const outbound = sanitizeHeaders(headers);
  if (method === 'GET') return outbound;

  const hasBody = body !== undefined && body !== null;
  if (!hasBody) return outbound;

  const hasContentType = Object.keys(outbound).some((name) => name.toLowerCase() === 'content-type');
  if (!hasContentType) outbound['Content-Type'] = 'application/json';
  return outbound;
}
