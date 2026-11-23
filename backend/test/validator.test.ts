import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, sanitizeHeaders, appendQueryParams } from '../src/services/validator.js';
import { config } from '../src/config/index.js';

function payload(overrides: Record<string, unknown> = {}, assertionOverrides: unknown[] = []) {
  return {
    request: {
      method: 'GET',
      url: 'https://example.com/users',
      headers: {},
      queryParams: {},
      ...overrides,
    },
    assertions:
      assertionOverrides.length > 0
        ? assertionOverrides
        : [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }],
  };
}

function codeOf(raw: unknown, bodyBytes = 10): string | null {
  return validatePayload(bodyBytes, raw)?.code ?? null;
}

describe('valid payload', () => {
  it('returns null when everything is valid', () => {
    assert.equal(validatePayload(10, payload()), null);
  });
});

describe('REQUEST_BODY_TOO_LARGE', () => {
  it('rejects a body above 1 MB', () => {
    const error = validatePayload(config.REQUEST_BODY_LIMIT_BYTES + 1, payload());
    assert.equal(error?.code, 'REQUEST_BODY_TOO_LARGE');
    assert.equal(error?.field, 'request.body');
  });

  it('accepts exactly 1 MB', () => {
    assert.equal(validatePayload(config.REQUEST_BODY_LIMIT_BYTES, payload()), null);
  });
});

describe('INVALID_JSON_BODY', () => {
  it('rejects a non-object payload', () => {
    assert.equal(codeOf('text'), 'INVALID_JSON_BODY');
  });

  it('rejects a payload without request', () => {
    assert.equal(codeOf({ assertions: [] }), 'INVALID_JSON_BODY');
  });
});

describe('INVALID_METHOD', () => {
  for (const method of ['TRACE', 'CONNECT', 'HEAD', 'get', '']) {
    it(`rejects method ${JSON.stringify(method)}`, () => {
      assert.equal(codeOf(payload({ method })), 'INVALID_METHOD');
    });
  }

  it('accepts every allowed method', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const body = payload({ method });
      if (method !== 'GET') (body.request as Record<string, unknown>).body = { a: 1 };
      assert.equal(validatePayload(10, body), null);
    }
  });
});

describe('INVALID_HEADER_VALUE', () => {
  it('rejects a newline in a header value', () => {
    const error = validatePayload(10, payload({ headers: { 'X-Test': 'line1\r\nX-Injected: evil' } }));
    assert.equal(error?.code, 'INVALID_HEADER_VALUE');
    assert.equal(error?.field, 'request.headers.X-Test');
  });

  it('rejects a bare carriage return', () => {
    assert.equal(codeOf(payload({ headers: { 'X-Test': 'a\rb' } })), 'INVALID_HEADER_VALUE');
  });

  it('rejects non-string header values', () => {
    assert.equal(codeOf(payload({ headers: { 'X-Test': 5 } })), 'INVALID_HEADER_VALUE');
  });
});

describe('INVALID_URL_FORMAT vs INVALID_URL_SCHEME', () => {
  it('rejects an empty URL as format', () => {
    assert.equal(codeOf(payload({ url: '' })), 'INVALID_URL_FORMAT');
  });

  it('rejects a blank URL as format', () => {
    assert.equal(codeOf(payload({ url: '   ' })), 'INVALID_URL_FORMAT');
  });

  it('rejects an unparseable URL as format', () => {
    assert.equal(codeOf(payload({ url: 'http://' })), 'INVALID_URL_FORMAT');
  });

  it('rejects a scheme-less string as format', () => {
    assert.equal(codeOf(payload({ url: 'example.com/users' })), 'INVALID_URL_FORMAT');
  });

  it('rejects file:// as scheme', () => {
    const error = validatePayload(10, payload({ url: 'file:///etc/passwd' }));
    assert.equal(error?.code, 'INVALID_URL_SCHEME');
    assert.equal(error?.field, 'request.url');
  });

  it('rejects gopher:// as scheme', () => {
    assert.equal(codeOf(payload({ url: 'gopher://example.com' })), 'INVALID_URL_SCHEME');
  });

  it('rejects ftp:// as scheme', () => {
    assert.equal(codeOf(payload({ url: 'ftp://example.com' })), 'INVALID_URL_SCHEME');
  });
});

describe('NO_ASSERTIONS', () => {
  it('rejects an empty array', () => {
    const error = validatePayload(10, { request: payload().request, assertions: [] });
    assert.equal(error?.code, 'NO_ASSERTIONS');
    assert.equal(error?.field, 'assertions');
  });

  it('rejects a missing array', () => {
    assert.equal(codeOf({ request: payload().request }), 'NO_ASSERTIONS');
  });
});

describe('INVALID_ASSERTION', () => {
  const cases: Array<[string, unknown, string]> = [
    ['unknown type', { type: 'BODY_TEXT', operator: 'equals', expectedValue: 1 }, 'assertions[0].type'],
    ['status with contains', { type: 'STATUS_CODE', operator: 'contains', expectedValue: 200 }, 'assertions[0].operator'],
    ['latency with equals', { type: 'LATENCY', operator: 'equals', expectedValue: 100 }, 'assertions[0].operator'],
    ['latency with negative value', { type: 'LATENCY', operator: 'less_than_or_equal', expectedValue: -10 }, 'assertions[0].expectedValue'],
    ['latency with string value', { type: 'LATENCY', operator: 'less_than_or_equal', expectedValue: '100' }, 'assertions[0].expectedValue'],
    ['json path without target', { type: 'BODY_JSON_PATH', operator: 'equals', expectedValue: 1 }, 'assertions[0].target'],
    ['exists with non-null expected', { type: 'BODY_JSON_PATH', operator: 'exists', target: 'a', expectedValue: 'x' }, 'assertions[0].expectedValue'],
    ['non-object assertion', 5, 'assertions[0]'],
  ];

  for (const [name, assertion, field] of cases) {
    it(`rejects ${name}`, () => {
      const error = validatePayload(10, payload({}, [assertion]));
      assert.equal(error?.code, 'INVALID_ASSERTION');
      assert.equal(error?.field, field);
    });
  }

  it('reports the correct index', () => {
    const error = validatePayload(10, payload({}, [
      { type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 },
      { type: 'STATUS_CODE', operator: 'contains', expectedValue: 200 },
    ]));
    assert.equal(error?.field, 'assertions[1].operator');
  });
});

describe('order of checks', () => {
  it('reports method before header problems', () => {
    assert.equal(codeOf(payload({ method: 'TRACE', headers: { X: 'a\r\nb' } })), 'INVALID_METHOD');
  });

  it('reports body size before anything else', () => {
    const error = validatePayload(config.REQUEST_BODY_LIMIT_BYTES + 1, { nonsense: true });
    assert.equal(error?.code, 'REQUEST_BODY_TOO_LARGE');
  });

  it('reports header problems before URL problems', () => {
    assert.equal(codeOf(payload({ url: 'file:///x', headers: { X: 'a\nb' } })), 'INVALID_HEADER_VALUE');
  });

  it('reports URL scheme before missing assertions', () => {
    const error = validatePayload(10, { request: payload({ url: 'file:///x' }).request, assertions: [] });
    assert.equal(error?.code, 'INVALID_URL_SCHEME');
  });
});

describe('sanitizeHeaders', () => {
  it('strips host, content-length, hop-by-hop, forwarding, and accept-encoding case-insensitively', () => {
    const result = sanitizeHeaders({
      Host: 'evil',
      'content-length': '999',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'X-Forwarded-For': '1.2.3.4',
      Forwarded: 'for=1.2.3.4',
      'Proxy-Authorization': 'Basic abc',
      'Accept-Encoding': 'br, gzip',
      'X-Keep': 'yes',
      Authorization: 'Bearer tok',
      HOST: 'x',
    });
    assert.deepEqual(result, { 'X-Keep': 'yes', Authorization: 'Bearer tok' });
  });
});

describe('security hardening validations', () => {
  it('rejects Object prototype property names as assertion type', () => {
    const error = validatePayload(10, payload({}, [{ type: 'toString', operator: 'equals', expectedValue: 200 }]));
    assert.equal(error?.code, 'INVALID_ASSERTION');
  });

  it('rejects non-primitive expectedValue for BODY_JSON_PATH equality/contains', () => {
    const nullProtoExpected = Object.assign(Object.create(null), { toString: null, valueOf: null });
    const err1 = validatePayload(10, payload({}, [{ type: 'BODY_JSON_PATH', operator: 'equals', target: 'a', expectedValue: nullProtoExpected }]));
    const err2 = validatePayload(10, payload({}, [{ type: 'BODY_JSON_PATH', operator: 'contains', target: 'a', expectedValue: ['x'] }]));
    assert.equal(err1?.code, 'INVALID_ASSERTION');
    assert.equal(err2?.code, 'INVALID_ASSERTION');
  });

  it('rejects excessive assertions count above cap', () => {
    const tooMany = Array.from({ length: 101 }, () => ({
      type: 'STATUS_CODE',
      operator: 'equals',
      expectedValue: 200,
    }));
    const error = validatePayload(10, payload({}, tooMany));
    assert.equal(error?.code, 'INVALID_ASSERTION');
  });

  it('rejects invalid header names and CTL characters in header values', () => {
    assert.equal(codeOf(payload({ headers: { 'Invalid Header Name': 'ok' } })), 'INVALID_HEADER_VALUE');
    assert.equal(codeOf(payload({ headers: { 'X-Ctl': 'bad\x00val' } })), 'INVALID_HEADER_VALUE');
  });

  it('rejects URLs with embedded userinfo credentials', () => {
    assert.equal(codeOf(payload({ url: 'https://user:pass@example.com/api' })), 'INVALID_URL_FORMAT');
  });
});

describe('appendQueryParams', () => {
  it('appends params to a URL without a query string', () => {
    assert.equal(appendQueryParams('https://example.com/a', { page: '2' }), 'https://example.com/a?page=2');
  });

  it('keeps existing params and adds new ones', () => {
    const result = appendQueryParams('https://example.com/a?x=1', { page: '2' });
    assert.match(result, /x=1/);
    assert.match(result, /page=2/);
  });

  it('overwrites a key that already exists', () => {
    const result = appendQueryParams('https://example.com/a?page=1', { page: '2' });
    assert.equal(result, 'https://example.com/a?page=2');
  });

  it('encodes special characters', () => {
    const result = appendQueryParams('https://example.com/a', { q: 'a b&c' });
    assert.equal(result, 'https://example.com/a?q=a+b%26c');
  });

  it('returns the URL unchanged when there are no params', () => {
    assert.equal(appendQueryParams('https://example.com/a', {}), 'https://example.com/a');
  });
});
