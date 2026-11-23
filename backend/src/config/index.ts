const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readTrustProxy(value: string | undefined): boolean | string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  const lower = trimmed.toLowerCase();
  if (TRUE_VALUES.has(lower)) return true;
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  return trimmed;
}

export const config = {
  PORT: readInt(process.env.PORT, 3001),
  HOST: process.env.HOST ?? '127.0.0.1',
  ALLOW_LOCAL_TARGETS: readBool(process.env.ALLOW_LOCAL_TARGETS, false),
  TRUST_PROXY: readTrustProxy(process.env.TRUST_PROXY),
  PROXY_API_KEY: (process.env.PROXY_API_KEY ?? '').trim(),

  /** 30 requests per minute per IP (docs/02 §4.2.A). */
  RATE_LIMIT_MAX: readInt(process.env.RATE_LIMIT_MAX, 30),
  RATE_LIMIT_WINDOW_MS: readInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  RATE_LIMIT_MAX_KEYS: readInt(process.env.RATE_LIMIT_MAX_KEYS, 10_000),

  /** 1 MB = 1_048_576 bytes (docs/02 §4.2.A). Applied pre-parse at Fastify bodyLimit too. */
  REQUEST_BODY_LIMIT_BYTES: 1_048_576,
  FASTIFY_BODY_LIMIT_BYTES: 1_048_576,

  /** Bounded DNS resolution timeout & max assertions/in-flight guard. */
  DNS_LOOKUP_TIMEOUT_MS: readInt(process.env.DNS_LOOKUP_TIMEOUT_MS, 5_000),
  MAX_ASSERTIONS: readInt(process.env.MAX_ASSERTIONS, 100),
  MAX_IN_FLIGHT_REQUESTS: readInt(process.env.MAX_IN_FLIGHT_REQUESTS, 20),

  /** Hard outbound timeout (docs/02 §3.7). Also bounds body reading. */
  OUTBOUND_TIMEOUT_MS: 15_000,
  /** Response cap (docs/02 §3.5). */
  RESPONSE_LIMIT_BYTES: 2 * 1_048_576,
} as const;

export type AppConfig = typeof config;
