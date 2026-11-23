import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { HttpMethod, NormalizedResponse } from '../models/types.js';

export interface DispatchTarget {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Pre-validated IPs resolved during pre-flight checkTarget() to defeat DNS rebinding. */
  resolvedAddresses?: string[];
}

export interface DispatchOptions {
  timeoutMs: number;
  responseLimitBytes: number;
  signal?: AbortSignal;
  /** Monotonic clock, injectable for tests. */
  clock?: () => number;
}

export type DispatchOutcome =
  | { kind: 'response'; response: NormalizedResponse; elapsedMs: number }
  | { kind: 'error'; reason: string; elapsedMs: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });
const FORBIDDEN_HEADER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Mirrors WHATWG Fetch restricted ports to prevent probing local/service ports. */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

function incomingHeadersToRecord(headers: http.IncomingHttpHeaders): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_HEADER_KEYS.has(lower) || value === undefined) continue;
    record[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return record;
}

function parseBody(
  text: string,
  truncated: boolean,
): { body: unknown; bodyIsJson: boolean } {
  // A truncated prefix is never parsed: it is not a valid JSON document by construction.
  if (truncated || text === '') return { body: text, bodyIsJson: false };

  try {
    const parsed: unknown = JSON.parse(text);
    return { body: parsed, bodyIsJson: true };
  } catch {
    return { body: text, bodyIsJson: false };
  }
}

export function bodyByteLength(body: string | undefined): number {
  return body === undefined ? 0 : encoder.encode(body).byteLength;
}

interface PinnedRecord {
  address: string;
  family: 4 | 6;
}

function toPinnedRecords(addresses?: string[]): PinnedRecord[] {
  if (!addresses || addresses.length === 0) return [];
  const records: PinnedRecord[] = [];
  for (const raw of addresses) {
    const clean = raw.split('%')[0] ?? raw;
    const ipVersion = net.isIP(clean);
    if (ipVersion === 4 || ipVersion === 6) {
      records.push({ address: raw, family: ipVersion });
    }
  }
  return records;
}

function createPinnedLookup(records: PinnedRecord[]) {
  return (_hostname: string, opts: unknown, cb?: unknown) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const optionsObj =
      typeof opts === 'object' && opts !== null ? (opts as { all?: boolean; family?: number }) : {};
    if (typeof callback !== 'function') return;

    const filtered =
      optionsObj.family === 4 || optionsObj.family === 6
        ? records.filter((r) => r.family === optionsObj.family)
        : records;
    const chosen = filtered.length > 0 ? filtered : records;

    process.nextTick(() => {
      if (optionsObj.all) {
        (callback as (err: null, addresses: PinnedRecord[]) => void)(null, chosen);
        return;
      }
      const first = chosen[0]!;
      (callback as (err: null, address: string, family: number) => void)(
        null,
        first.address,
        first.family,
      );
    });
  };
}

/**
 * Send one request directly to the target without following redirects and cap the
 * response body at 2 MB. Domain targets pin pre-validated IPs to defeat DNS rebinding.
 */
export async function dispatch(target: DispatchTarget, options: DispatchOptions): Promise<DispatchOutcome> {
  const clock = options.clock ?? (() => performance.now());
  const startedAt = clock();

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(target.url);
  } catch {
    return { kind: 'error', reason: 'Format URL target tidak valid.', elapsedMs: clock() - startedAt };
  }

  if (parsedUrl.port !== '') {
    const portNum = Number.parseInt(parsedUrl.port, 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || BLOCKED_PORTS.has(portNum)) {
      return {
        kind: 'error',
        reason: 'Target menggunakan port yang tidak diizinkan.',
        elapsedMs: clock() - startedAt,
      };
    }
  }

  const hostWithoutBrackets = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const pinnedRecords = toPinnedRecords(target.resolvedAddresses);
  const pinnedLookup =
    net.isIP(hostWithoutBrackets) === 0 && pinnedRecords.length > 0
      ? createPinnedLookup(pinnedRecords)
      : undefined;

  const timeoutController = new AbortController();
  const combinedSignal = options.signal
    ? AbortSignal.any([timeoutController.signal, options.signal])
    : timeoutController.signal;
  const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs);

  const client = parsedUrl.protocol === 'https:' ? https : http;
  const outboundHeaders: Record<string, string> = { ...target.headers };
  if (target.body !== undefined) {
    outboundHeaders['Content-Length'] = String(bodyByteLength(target.body));
  }

  try {
    return await new Promise<DispatchOutcome>((resolve) => {
      let settled = false;

      const finish = (outcome: DispatchOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      const req = client.request(
        parsedUrl,
        {
          method: target.method,
          headers: outboundHeaders,
          agent: false,
          signal: combinedSignal,
          ...(pinnedLookup ? { lookup: pinnedLookup as unknown as http.RequestOptions['lookup'] } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let truncated = false;
          const limit = options.responseLimitBytes;

          const finalizeResponse = () => {
            const elapsedMs = clock() - startedAt;
            const bytes = Buffer.concat(chunks, total);
            const text = decoder.decode(bytes);
            const { body, bodyIsJson } = parseBody(text, truncated);

            finish({
              kind: 'response',
              elapsedMs,
              response: {
                statusCode: res.statusCode ?? 0,
                responseTimeMs: Math.round(elapsedMs),
                bodySizeBytes: bytes.byteLength,
                truncated,
                headers: incomingHeadersToRecord(res.headers),
                body,
                bodyIsJson,
              },
            });
          };

          res.on('data', (chunk: Buffer) => {
            if (settled) return;
            const remaining = limit - total;
            if (chunk.byteLength > remaining) {
              if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
              total = limit;
              truncated = true;
              finalizeResponse();
              res.destroy();
              req.destroy();
              return;
            }
            chunks.push(chunk);
            total += chunk.byteLength;
          });

          res.on('end', finalizeResponse);
          res.on('aborted', () => {
            if (settled) return;
            const elapsedMs = clock() - startedAt;
            finish({
              kind: 'error',
              reason: timeoutController.signal.aborted
                ? timeoutReason(options.timeoutMs)
                : options.signal?.aborted
                  ? 'Request dibatalkan.'
                  : 'Koneksi ke target terputus saat membaca response.',
              elapsedMs,
            });
          });
          res.on('error', (err) => {
            if (settled) return;
            const elapsedMs = clock() - startedAt;
            finish({
              kind: 'error',
              reason: describeSocketError(
                err,
                options.timeoutMs,
                timeoutController.signal.aborted,
                Boolean(options.signal?.aborted),
              ),
              elapsedMs,
            });
          });
        },
      );

      req.on('error', (err) => {
        if (settled) return;
        const elapsedMs = clock() - startedAt;
        finish({
          kind: 'error',
          reason: describeSocketError(
            err,
            options.timeoutMs,
            timeoutController.signal.aborted,
            Boolean(options.signal?.aborted),
          ),
          elapsedMs,
        });
      });

      if (target.body !== undefined) {
        req.write(target.body);
      }
      req.end();
    });
  } finally {
    clearTimeout(timer);
  }
}

function timeoutReason(timeoutMs: number): string {
  return `Connection timeout setelah ${timeoutMs}ms`;
}

function extractErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const direct = (error as { code?: string }).code;
  if (direct) return direct;
  if (error instanceof AggregateError && error.errors.length > 0) {
    const first = error.errors[0] as { code?: string } | undefined;
    return first?.code;
  }
  const cause = error.cause as { code?: string } | undefined;
  return cause?.code;
}

function describeSocketError(
  error: unknown,
  timeoutMs: number,
  timedOut: boolean,
  clientAborted: boolean,
): string {
  if (timedOut || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) {
    return clientAborted && !timedOut ? 'Request dibatalkan.' : timeoutReason(timeoutMs);
  }

  const code = extractErrorCode(error);
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'DNS gagal: host target tidak dapat di-resolve.';
    case 'ECONNREFUSED':
      return 'Koneksi ditolak oleh target.';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'Koneksi terputus oleh target.';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `Sertifikat SSL target tidak valid (${code}).`;
    default:
      return 'Gagal menghubungi server target.';
  }
}
