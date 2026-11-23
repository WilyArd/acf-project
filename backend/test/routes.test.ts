import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { dispatch } from '../src/services/dispatcher.js';
import { RateLimiter } from '../src/services/rateLimiter.js';

interface TargetState {
  hits: number;
  lastHeaders: Record<string, string | string[] | undefined>;
  lastMethod: string;
  lastBody: string;
}

const state: TargetState = { hits: 0, lastHeaders: {}, lastMethod: '', lastBody: '' };
let target: FastifyInstance;
let targetBase: string;

function targetPayload() {
  return {
    request: {
      method: 'GET',
      url: `${targetBase}/ok`,
      headers: {},
      queryParams: {},
    },
    assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
  };
}

async function app(overrides: { rateLimitMax?: number; allowLocal?: boolean } = {}) {
  const rateLimiter = new RateLimiter({
    max: overrides.rateLimitMax ?? 1000,
    windowMs: 60_000,
  });
  // Loopback targets need ALLOW_LOCAL_TARGETS for the happy paths; SSRF cases opt out.
  return buildApp({ rateLimiter, logger: false, allowLocalTargets: overrides.allowLocal ?? true });
}

before(async () => {
  target = Fastify({ logger: false });
  // addContentTypeParser so a custom Content-Type test can still read the raw body.
  target.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  target.post('/echo', async (request, reply) => {
    state.lastHeaders = request.headers;
    state.lastMethod = request.method;
    state.lastBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    return reply.code(201).send({ ok: true });
  });
  target.get('/ok', async (request, reply) => {
    state.hits += 1;
    state.lastHeaders = request.headers;
    return reply.code(200).send({ status: 'success', data: { id: 1, token: null, roles: ['admin'] } });
  });
  target.get('/slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { slow: true };
  });
  target.get('/text', async (_request, reply) => reply.code(200).type('text/plain').send('hello plain'));
  target.get('/big', async (_request, reply) => reply.code(200).type('application/json').send({ blob: 'x'.repeat(3 * 1024 * 1024) }));
  target.get('/redirect', async (_request, reply) => reply.code(302).header('location', '/ok').send());
  target.get('/boom', async (_request, reply) => reply.code(500).send({ error: 'upstream' }));

  await target.listen({ port: 0, host: '127.0.0.1' });
  const address = target.server.address();
  if (typeof address === 'object' && address) {
    targetBase = `http://127.0.0.1:${address.port}`;
  }
});

after(async () => {
  await target.close();
});

describe('PASS path', () => {
  it('returns PASS with details and raw response', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/ok`, headers: {}, queryParams: {} },
        assertions: [
          { type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 },
          { type: 'BODY_JSON_PATH', operator: 'equals', target: 'data.id', expectedValue: 1 },
          { type: 'BODY_JSON_PATH', operator: 'exists', target: 'data.token', expectedValue: null },
          { type: 'LATENCY', operator: 'less_than_or_equal', expectedValue: 5000 },
        ],
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.overallStatus, 'PASS');
    assert.equal(body.totalAssertions, 4);
    assert.equal(body.passedCount, 4);
    assert.equal(body.failedCount, 0);
    assert.equal(body.rawResponse.statusCode, 200);
    assert.equal(body.rawResponse.truncated, false);
    assert.deepEqual(body.rawResponse.body, { status: 'success', data: { id: 1, token: null, roles: ['admin'] } });
    assert.equal(typeof body.executedAt, 'string');
    assert.ok(body.rawResponse.responseTimeMs >= 0);
    // exists on a null value: found true, actual null
    const existsDetail = body.assertionDetails.find((d: { operator: string }) => d.operator === 'exists');
    assert.equal(existsDetail.found, true);
    assert.equal(existsDetail.actual, null);
    await instance.close();
  });
});

describe('FAIL path', () => {
  it('returns FAIL with 200 and a failing detail', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/ok`, headers: {}, queryParams: {} },
        assertions: [
          { type: 'STATUS_CODE', operator: 'equals', expectedValue: 404 },
          { type: 'BODY_JSON_PATH', operator: 'equals', target: 'missing.path', expectedValue: 'x' },
        ],
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.overallStatus, 'FAIL');
    assert.equal(body.passedCount, 0);
    assert.equal(body.failedCount, 2);
    assert.equal(body.assertionDetails[1].reason, 'path tidak ditemukan');
    assert.equal(body.assertionDetails[1].found, false);
    await instance.close();
  });

  it('treats a 500 from the target as a FAIL, not an ERROR', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/boom`, headers: {}, queryParams: {} },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
      },
    });
    assert.equal(response.json().overallStatus, 'FAIL');
    assert.equal(response.json().rawResponse.statusCode, 500);
    await instance.close();
  });
});

describe('non-JSON body', () => {
  it('keeps the raw string and fails BODY_JSON_PATH', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/text`, headers: {}, queryParams: {} },
        assertions: [
          { type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 },
          { type: 'BODY_JSON_PATH', operator: 'exists', target: 'anything', expectedValue: null },
        ],
      },
    });
    const body = response.json();
    assert.equal(body.rawResponse.body, 'hello plain');
    assert.equal(body.assertionDetails[1].status, 'FAIL');
    assert.equal(body.assertionDetails[1].reason, 'Response body bukan JSON valid');
    await instance.close();
  });
});

describe('truncation at 2MB', () => {
  it('caps the body and flags truncated', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/big`, headers: {}, queryParams: {} },
        assertions: [{ type: 'BODY_JSON_PATH', operator: 'exists', target: 'blob', expectedValue: null }],
      },
    });
    const body = (response as { json: () => { rawResponse: Record<string, unknown>; assertionDetails: Array<{ reason: string }> } }).json();
    assert.equal(body.rawResponse.truncated, true);
    assert.equal(body.rawResponse.bodySizeBytes, 2 * 1024 * 1024);
    assert.equal(typeof body.rawResponse.body, 'string');
    assert.equal(body.assertionDetails[0]!.reason, 'Response body dipotong pada 2MB, tidak bisa diparse');
    await instance.close();
  });
});

describe('redirects are not followed', () => {
  it('returns the 3xx status as-is', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/redirect`, headers: {}, queryParams: {} },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 302 }],
      },
    });
    const body = response.json();
    assert.equal(body.rawResponse.statusCode, 302);
    assert.equal(body.overallStatus, 'PASS');
    await instance.close();
  });
});

describe('outbound request shaping', () => {
  it('sends JSON body with automatic Content-Type and strips Host', async () => {
    const instance = await app();
    await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: {
          method: 'POST',
          url: `${targetBase}/echo`,
          headers: { 'Host': 'evil.example', 'X-Custom': 'kept' },
          queryParams: {},
          body: { a: 1 },
        },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 201 }],
      },
    });

    assert.equal(state.lastMethod, 'POST');
    assert.equal(state.lastHeaders['content-type'], 'application/json');
    assert.equal(state.lastHeaders['x-custom'], 'kept');
    assert.notEqual(state.lastHeaders['host'], 'evil.example');
    assert.equal(state.lastBody, '{"a":1}');
    await instance.close();
  });

  it('does not send a body or Content-Type for GET', async () => {
    const instance = await app();
    await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: {
          method: 'GET',
          url: `${targetBase}/ok`,
          headers: {},
          queryParams: {},
          body: { ignored: true },
        },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
      },
    });
    assert.equal(state.lastHeaders['content-type'], undefined);
    await instance.close();
  });

  it('keeps a user-supplied Content-Type', async () => {
    const instance = await app();
    await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: {
          method: 'POST',
          url: `${targetBase}/echo`,
          headers: { 'content-type': 'application/vnd.custom+json' },
          queryParams: {},
          body: { a: 1 },
        },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 201 }],
      },
    });
    assert.equal(state.lastHeaders['content-type'], 'application/vnd.custom+json');
    await instance.close();
  });

  it('appends query params to the URL', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: {
          method: 'GET',
          url: `${targetBase}/ok`,
          headers: {},
          queryParams: { page: '2', q: 'a b' },
        },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().overallStatus, 'PASS');
    await instance.close();
  });
});

describe('ERROR paths', () => {
  it('returns ERROR for a refused connection', async () => {
    const instance = await app();
    // Find a port that nothing listens on (close a listener and reuse its port).
    const probe = Fastify({ logger: false });
    await probe.listen({ port: 0, host: '127.0.0.1' });
    const probeAddress = probe.server.address();
    await probe.close();
    const closedPort = typeof probeAddress === 'object' && probeAddress ? probeAddress.port : 0;

    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `http://127.0.0.1:${closedPort}/never`, headers: {}, queryParams: {} },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.overallStatus, 'ERROR');
    assert.equal(body.assertionDetails.length, 0);
    assert.equal(body.rawResponse, null);
    assert.equal(body.totalAssertions, 0);
    assert.match(body.errorReason, /Koneksi ditolak|ECONNREFUSED|fetch failed/);
    await instance.close();
  });
});

describe('pre-flight rejections never reach the target', () => {
  it('400 on invalid assertion leaves the target untouched', async () => {
    const instance = await app();
    const before = state.hits;
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/ok`, headers: {}, queryParams: {} },
        assertions: [{ type: 'STATUS_CODE', operator: 'contains', expectedValue: 200 }],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      error: {
        code: 'INVALID_ASSERTION',
        message: 'Kombinasi type × operator tidak valid untuk STATUS_CODE.',
        field: 'assertions[0].operator',
      },
    });
    assert.equal(state.hits, before);
    await instance.close();
  });

  it('400 INVALID_HEADER_VALUE with a CRLF header', async () => {
    const instance = await app();
    const before = state.hits;
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/ok`, headers: { 'X-Bad': 'a\r\nB: c' }, queryParams: {} },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_HEADER_VALUE');
    assert.equal(state.hits, before);
    await instance.close();
  });

  it('400 INVALID_URL_SCHEME with file://', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: 'file:///etc/passwd', headers: {}, queryParams: {} },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_URL_SCHEME');
    await instance.close();
  });

  it('400 INVALID_JSON_BODY on malformed JSON (Fastify parser remapped)', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      headers: { 'content-type': 'application/json' },
      payload: '{"request": {',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_JSON_BODY');
    await instance.close();
  });

  it('400 REQUEST_BODY_TOO_LARGE above 1 MB (handler-level check)', async () => {
    const instance = await app();
    const big = { request: payload_padding(), assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }] };
    const response = await instance.inject({ method: 'POST', url: '/api/proxy/execute', payload: big });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'REQUEST_BODY_TOO_LARGE');
    await instance.close();
  });

  it('400 REQUEST_BODY_TOO_LARGE above Fastify bodyLimit (remapped from 413)', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ request: { url: 'x', pad: 'y'.repeat(2.5 * 1024 * 1024) }, assertions: [] }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'REQUEST_BODY_TOO_LARGE');
    await instance.close();
  });

  it('429 on the 31st request in the window', async () => {
    const instance = await app({ rateLimitMax: 30 });
    const request = {
      request: { method: 'GET', url: 'file:///etc/passwd', headers: {}, queryParams: {} },
      assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
    };
    for (let i = 0; i < 30; i += 1) {
      const response = await instance.inject({ method: 'POST', url: '/api/proxy/execute', payload: request });
      assert.equal(response.statusCode, 400);
    }
    const limited = await instance.inject({ method: 'POST', url: '/api/proxy/execute', payload: request });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMIT_EXCEEDED');
    assert.equal(limited.json().error.field, null);
    await instance.close();
  });
});

function payload_padding() {
  return {
    method: 'GET',
    url: 'https://example.com/x',
    headers: {},
    queryParams: {},
    body: 'x'.repeat(1.1 * 1024 * 1024),
  };
}

describe('SSRF policy at the route', () => {
  it('blocks a loopback target when ALLOW_LOCAL_TARGETS is false', async () => {
    const instance = await app({ allowLocal: false });
    const before = state.hits;
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: targetPayload(),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'LOCAL_TARGET_BLOCKED');
    assert.equal(response.json().error.field, 'request.url');
    assert.equal(state.hits, before);
    await instance.close();
  });
});

describe('unknown route', () => {
  it('returns a JSON 404 instead of HTML', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: '/nope' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'NOT_FOUND');
    await instance.close();
  });
});

describe('backend security hardenings', () => {
  it('pins dispatch to pre-resolved IP addresses to defeat DNS rebinding', async () => {
    const targetPort = new URL(targetBase).port;
    const outcome = await dispatch(
      {
        method: 'GET',
        url: `http://pinned-rebinding-test.invalid:${targetPort}/ok`,
        headers: {},
        resolvedAddresses: ['127.0.0.1'],
      },
      { timeoutMs: 2000, responseLimitBytes: 1024 * 1024 },
    );
    assert.equal(outcome.kind, 'response');
    if (outcome.kind === 'response') {
      assert.equal(outcome.response.statusCode, 200);
    }
  });

  it('blocks restricted service ports such as 22 cleanly as ERROR', async () => {
    const instance = await app({ allowLocal: true });
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: 'http://127.0.0.1:22/ssh', headers: {}, queryParams: {} },
        assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.overallStatus, 'ERROR');
    assert.match(body.errorReason, /port/i);
    await instance.close();
  });

  it('rejects 429 before JSON parsing on oversized or malformed flood requests', async () => {
    const instance = await app({ rateLimitMax: 2 });
    const validReq = {
      request: { method: 'GET', url: 'file:///etc/passwd', headers: {}, queryParams: {} },
      assertions: [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
    };
    await instance.inject({ method: 'POST', url: '/api/proxy/execute', payload: validReq });
    await instance.inject({ method: 'POST', url: '/api/proxy/execute', payload: validReq });

    const limited = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      headers: { 'content-type': 'application/json' },
      payload: '{bad-json-should-not-parse' + 'x'.repeat(200),
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMIT_EXCEEDED');
    await instance.close();
  });

  it('returns 400 INVALID_ASSERTION instead of 500 when expectedValue has {toString: null}', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/proxy/execute',
      payload: {
        request: { method: 'GET', url: `${targetBase}/ok`, headers: {}, queryParams: {} },
        assertions: [
          {
            type: 'BODY_JSON_PATH',
            operator: 'equals',
            target: 'data.id',
            expectedValue: { toString: null, valueOf: null },
          },
        ],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_ASSERTION');
    await instance.close();
  });

  it('sets defensive response headers and enforces bounded RateLimiter map', async () => {
    const limiter = new RateLimiter({ max: 5, windowMs: 60_000, maxKeys: 10 });
    for (let i = 0; i < 25; i += 1) {
      assert.equal(limiter.check(`192.0.2.${i}`), true);
    }
    assert.ok(limiter.size <= 10);

    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/api/proxy/execute', payload: targetPayload() });
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
    await instance.close();
  });
});
