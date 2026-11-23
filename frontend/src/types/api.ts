export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const ALLOWED_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export type AssertionType = 'STATUS_CODE' | 'LATENCY' | 'BODY_JSON_PATH';

export type AssertionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'exists'
  | 'less_than_or_equal';

export const OPERATORS_BY_TYPE: Record<AssertionType, readonly AssertionOperator[]> = {
  STATUS_CODE: ['equals'],
  LATENCY: ['less_than_or_equal'],
  BODY_JSON_PATH: ['equals', 'not_equals', 'contains', 'exists'],
};

export interface AssertionRule {
  type: AssertionType;
  operator: AssertionOperator;
  target?: string | null;
  expectedValue: unknown;
}

export interface AssertionDraft {
  id: string;
  enabled: boolean;
  type: AssertionType;
  operator: AssertionOperator;
  target: string;
  expectedInput: string;
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

export interface RawResponse {
  statusCode: number;
  responseTimeMs: number;
  bodySizeBytes: number;
  truncated: boolean;
  headers: Record<string, string>;
  body: unknown;
}

export interface ResultPayload {
  overallStatus: 'PASS' | 'FAIL';
  totalAssertions: number;
  passedCount: number;
  failedCount: number;
  executedAt: string;
  assertionDetails: AssertionDetail[];
  rawResponse: RawResponse;
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
  httpStatus?: number;
}

export interface KeyValueRow {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
  description: string;
}

export type EnvVarType = 'default' | 'secret';

export interface EnvVariable {
  id: string;
  enabled: boolean;
  key: string;
  type: EnvVarType;
  initialValue: string;
  currentValue: string;
}

export interface Environment {
  id: string;
  name: string;
  variables: EnvVariable[];
}

export interface PostResponseVarRule {
  target: 'environment' | 'collection';
  varName: string;
  sourcePath: string;
  prefix?: string;
}

export interface CollectionRequestItem {
  id: string;
  name: string;
  folderPath: string[];
  method: HttpMethod;
  url: string;
  headers: KeyValueRow[];
  queryParams: KeyValueRow[];
  bodyText: string;
  warnings: string[];
  postResponseVars?: PostResponseVarRule[];
}

export interface CollectionGroup {
  id: string;
  name: string;
  items: CollectionRequestItem[];
}

/**
 * Strict localStorage whitelist (AGENTS.md Golden Rule & docs/05 §5).
 * Headers, body, credentials, and tokens are strictly forbidden here.
 */
export interface HistoryEntry {
  method: HttpMethod;
  url: string;
  timestamp: string;
  overallStatus: 'PASS' | 'FAIL' | 'ERROR';
  passedCount: number;
  failedCount: number;
}

export type ThemeMode = 'dark' | 'light';
