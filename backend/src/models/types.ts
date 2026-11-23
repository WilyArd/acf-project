export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const ALLOWED_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export type AssertionType = 'STATUS_CODE' | 'LATENCY' | 'BODY_JSON_PATH';

export type AssertionOperator = 'equals' | 'not_equals' | 'contains' | 'exists' | 'less_than_or_equal';

export interface AssertionRule {
  type: AssertionType;
  operator: AssertionOperator;
  target?: string | null;
  expectedValue: unknown;
}

export interface RequestSpecInput {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  body?: unknown;
}

export interface ExecutePayload {
  request: RequestSpecInput;
  assertions: AssertionRule[];
}

export type Verdict = 'PASS' | 'FAIL';

export interface AssertionDetail {
  type: AssertionType;
  target: string | null;
  operator: AssertionOperator;
  expected: unknown;
  actual: unknown;
  found: boolean;
  status: Verdict;
  reason?: string;
}

/** Response as captured by the dispatcher, before assertion evaluation. */
export interface NormalizedResponse {
  statusCode: number;
  responseTimeMs: number;
  bodySizeBytes: number;
  truncated: boolean;
  headers: Record<string, string>;
  /** Parsed JSON when the body is valid JSON and not truncated; otherwise the raw string. */
  body: unknown;
  /** True when `body` is a parsed JSON value (object/array/number/string/boolean/null). */
  bodyIsJson: boolean;
}

export interface ResultPayload {
  overallStatus: 'PASS' | 'FAIL';
  totalAssertions: number;
  passedCount: number;
  failedCount: number;
  executedAt: string;
  assertionDetails: AssertionDetail[];
  rawResponse: Omit<NormalizedResponse, 'bodyIsJson'> & { body: unknown };
}

export interface ErrorPayload {
  overallStatus: 'ERROR';
  totalAssertions: 0;
  passedCount: 0;
  failedCount: 0;
  executedAt: string;
  errorReason: string;
  assertionDetails: [];
  rawResponse: null;
}

export type ErrorCode =
  | 'INVALID_URL_FORMAT'
  | 'INVALID_URL_SCHEME'
  | 'NO_ASSERTIONS'
  | 'INVALID_ASSERTION'
  | 'INVALID_JSON_BODY'
  | 'INVALID_METHOD'
  | 'REQUEST_BODY_TOO_LARGE'
  | 'INVALID_HEADER_VALUE'
  | 'LOCAL_TARGET_BLOCKED'
  | 'RATE_LIMIT_EXCEEDED';

export interface ValidationError {
  code: ErrorCode;
  message: string;
  field: string | null;
}
