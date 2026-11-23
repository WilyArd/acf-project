import { ALLOWED_METHODS, type AssertionRule, type ExecutePayload, type HttpMethod, type RequestSpecInput, type ValidationError } from '../models/types.js';
import { config } from '../config/index.js';

const TYPE_OPERATORS = new Map<string, readonly string[]>([
  ['STATUS_CODE', ['equals']],
  ['LATENCY', ['less_than_or_equal']],
  ['BODY_JSON_PATH', ['equals', 'not_equals', 'contains', 'exists']],
]);

const RFC9110_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CTL_HEADER_VALUE = /[\x00-\x08\x0a-\x1f\x7f]/;
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const STRIPPED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'accept-encoding',
]);

function fail(code: ValidationError['code'], message: string, field: string | null): ValidationError {
  return { code, message, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the inbound payload BEFORE any DNS resolution or outbound request.
 *
 * Order follows docs/04 §3 with two additions up front (body size, JSON body) because
 * nothing below can run until the payload has been read and parsed.
 */
export function validatePayload(rawBodyBytes: number, payload: unknown): ValidationError | null {
  // 1. Inbound body size (docs/02 §4.2.A)
  if (rawBodyBytes > config.REQUEST_BODY_LIMIT_BYTES) {
    return fail('REQUEST_BODY_TOO_LARGE', 'Ukuran request body melebihi batas 1MB.', 'request.body');
  }

  if (!isRecord(payload)) {
    return fail('INVALID_JSON_BODY', 'Request body bukan JSON yang valid.', 'request');
  }

  const request = payload.request;
  const assertions = payload.assertions;

  if (!isRecord(request)) {
    return fail('INVALID_JSON_BODY', 'Request body tidak memuat objek "request".', 'request');
  }

  // 2. Method allowlist
  const method = request.method;
  if (typeof method !== 'string' || !ALLOWED_METHODS.includes(method as HttpMethod)) {
    return fail(
      'INVALID_METHOD',
      'HTTP method harus salah satu dari GET, POST, PUT, PATCH, DELETE.',
      'request.method',
    );
  }

  // 3. Header values: CRLF injection (docs/02 §4.2.A)
  const headerError = validateHeaders(request.headers);
  if (headerError) return headerError;

  const queryError = validateStringRecord(request.queryParams, 'request.queryParams');
  if (queryError) return queryError;

  // 4. URL format, then scheme
  const url = request.url;
  if (typeof url !== 'string' || url.trim() === '') {
    return fail('INVALID_URL_FORMAT', 'URL kosong atau tidak valid.', 'request.url');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('INVALID_URL_FORMAT', 'URL kosong atau tidak valid.', 'request.url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('INVALID_URL_SCHEME', 'Skema URL harus http atau https.', 'request.url');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return fail('INVALID_URL_FORMAT', 'URL tidak boleh menyertakan kredensial userinfo.', 'request.url');
  }

  // 5. Assertions
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return fail('NO_ASSERTIONS', 'Minimal 1 assertion wajib dikonfigurasi.', 'assertions');
  }
  if (assertions.length > config.MAX_ASSERTIONS) {
    return fail(
      'INVALID_ASSERTION',
      `Jumlah assertion melebihi batas maksimal ${config.MAX_ASSERTIONS}.`,
      'assertions',
    );
  }

  for (let index = 0; index < assertions.length; index += 1) {
    const assertionError = validateAssertion(assertions[index], index);
    if (assertionError) return assertionError;
  }

  return null;
}

function validateHeaders(headers: unknown): ValidationError | null {
  if (headers === undefined) return null;
  if (!isRecord(headers)) {
    return fail('INVALID_HEADER_VALUE', 'Header harus berupa objek key-value berbentuk string.', 'request.headers');
  }

  for (const [name, value] of Object.entries(headers)) {
    const field = `request.headers.${name}`;
    if (!name || name.length > 256 || !RFC9110_HEADER_NAME.test(name)) {
      return fail('INVALID_HEADER_VALUE', `Nama header "${name}" tidak valid.`, field);
    }
    if (typeof value !== 'string') {
      return fail('INVALID_HEADER_VALUE', `Nilai header "${name}" harus berupa string.`, field);
    }
    if (CTL_HEADER_VALUE.test(value)) {
      return fail(
        'INVALID_HEADER_VALUE',
        `Nilai header "${name}" mengandung karakter kontrol/newline yang tidak diizinkan.`,
        field,
      );
    }
  }
  return null;
}

function validateStringRecord(value: unknown, fieldName: string): ValidationError | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    return fail('INVALID_JSON_BODY', `${fieldName} harus berupa objek key-value.`, fieldName);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return fail('INVALID_JSON_BODY', `${fieldName}.${key} harus berupa string.`, `${fieldName}.${key}`);
    }
  }
  return null;
}

function validateAssertion(assertion: unknown, index: number): ValidationError | null {
  const field = `assertions[${index}]`;
  if (!isRecord(assertion)) {
    return fail('INVALID_ASSERTION', 'Assertion harus berupa objek.', field);
  }

  const { type, operator, target, expectedValue } = assertion;
  const allowedOperators = typeof type === 'string' ? TYPE_OPERATORS.get(type) : undefined;

  if (!allowedOperators) {
    return fail('INVALID_ASSERTION', 'Tipe assertion tidak dikenali.', `${field}.type`);
  }
  if (typeof operator !== 'string' || !allowedOperators.includes(operator)) {
    return fail(
      'INVALID_ASSERTION',
      `Kombinasi type × operator tidak valid untuk ${type}.`,
      `${field}.operator`,
    );
  }

  if (type === 'LATENCY') {
    const numeric = typeof expectedValue === 'number' ? expectedValue : Number.NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return fail(
        'INVALID_ASSERTION',
        'expectedValue untuk LATENCY harus berupa angka positif.',
        `${field}.expectedValue`,
      );
    }
  }

  if (type === 'STATUS_CODE') {
    const numeric = typeof expectedValue === 'number' ? expectedValue : Number.NaN;
    if (!Number.isFinite(numeric)) {
      return fail(
        'INVALID_ASSERTION',
        'expectedValue untuk STATUS_CODE harus berupa angka.',
        `${field}.expectedValue`,
      );
    }
  }

  if (type === 'BODY_JSON_PATH') {
    if (typeof target !== 'string' || target.trim() === '' || target.length > 512) {
      return fail('INVALID_ASSERTION', 'target wajib diisi untuk BODY_JSON_PATH.', `${field}.target`);
    }
    if (operator === 'exists') {
      if (expectedValue !== null) {
        return fail(
          'INVALID_ASSERTION',
          'expectedValue untuk operator exists harus null.',
          `${field}.expectedValue`,
        );
      }
    } else {
      const validPrimitive =
        expectedValue === null ||
        typeof expectedValue === 'string' ||
        typeof expectedValue === 'boolean' ||
        (typeof expectedValue === 'number' && Number.isFinite(expectedValue));
      if (!validPrimitive) {
        return fail(
          'INVALID_ASSERTION',
          `expectedValue untuk operator ${operator} harus berupa nilai primitif.`,
          `${field}.expectedValue`,
        );
      }
    }
  }

  return null;
}

/** Header names/values forwarded to the target, with protocol-controlled ones stripped. */
export function sanitizeHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(headers)) return result;

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_PROTO_KEYS.has(lower)) continue;
    if (STRIPPED_HEADERS.has(lower) || lower.startsWith('proxy-')) continue;
    if (typeof value !== 'string') continue;
    if (!RFC9110_HEADER_NAME.test(name) || CTL_HEADER_VALUE.test(value)) continue;
    result[name] = value;
  }
  return result;
}

/** Query params appended one-way; existing keys in the URL are overwritten by table values. */
export function appendQueryParams(url: string, queryParams: unknown): string {
  if (!isRecord(queryParams) || Object.keys(queryParams).length === 0) return url;
  const parsed = new URL(url);
  const search = new URLSearchParams(parsed.search);
  for (const [key, value] of Object.entries(queryParams)) {
    if (typeof value !== 'string') continue;
    search.set(key, value);
  }
  parsed.search = search.toString();
  return parsed.toString();
}

/** Narrow a validated payload to its typed shape. */
export function asExecutePayload(payload: unknown): ExecutePayload {
  const record = payload as { request: RequestSpecInput; assertions: AssertionRule[] };
  return {
    request: record.request,
    assertions: record.assertions,
  };
}
