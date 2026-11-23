import { getJsonPath } from './getJsonPath.js';
import type { AssertionDetail, AssertionRule, NormalizedResponse, Verdict } from '../../models/types.js';

/** User-visible strings are Indonesian and must match docs/04 verbatim (CLAUDE.md § Language). */
export const REASON = {
  pathNotFound: 'path tidak ditemukan',
  unsupportedEquals: 'tipe tidak didukung untuk operator equals/not_equals',
  unsupportedContains: 'tipe tidak didukung untuk operator contains',
  truncated: 'Response body dipotong pada 2MB, tidak bisa diparse',
  notJson: 'Response body bukan JSON valid',
} as const;

type JsonLike = unknown;

const MISSING = Symbol('missing');

function isPlainContainer(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function safePrimitiveString(value: unknown): string | null {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return value as string;
  if (kind === 'number' || kind === 'boolean' || kind === 'bigint') return String(value);
  return null;
}

/** `equals` / `not_equals`: both sides string-normalised; object/array values are rejected safely. */
function evaluateEquality(
  rule: AssertionRule,
  actual: unknown,
): { status: Verdict; reason?: string } {
  if (isPlainContainer(actual)) {
    return { status: 'FAIL', reason: REASON.unsupportedEquals };
  }
  const actualStr = safePrimitiveString(actual);
  const expectedStr = safePrimitiveString(rule.expectedValue);
  if (actualStr === null || expectedStr === null) {
    return { status: 'FAIL', reason: REASON.unsupportedEquals };
  }
  const equal = actualStr === expectedStr;
  const matched = rule.operator === 'equals' ? equal : !equal;
  return { status: matched ? 'PASS' : 'FAIL' };
}

function contains(actual: unknown, expected: unknown): { status: Verdict; reason?: string } {
  const expectedStr = safePrimitiveString(expected);
  if (expectedStr === null) {
    return { status: 'FAIL', reason: REASON.unsupportedContains };
  }
  if (typeof actual === 'string') {
    return { status: actual.includes(expectedStr) ? 'PASS' : 'FAIL' };
  }
  if (Array.isArray(actual)) {
    const hit = actual.some((entry) => !isPlainContainer(entry) && safePrimitiveString(entry) === expectedStr);
    return { status: hit ? 'PASS' : 'FAIL' };
  }
  return { status: 'FAIL', reason: REASON.unsupportedContains };
}

function detail(
  rule: AssertionRule,
  actual: unknown,
  found: boolean,
  outcome: { status: Verdict; reason?: string },
): AssertionDetail {
  const base: AssertionDetail = {
    type: rule.type,
    target: rule.target ?? null,
    operator: rule.operator,
    expected: rule.type === 'BODY_JSON_PATH' && rule.operator === 'exists' ? null : rule.expectedValue,
    actual: actual === MISSING ? null : actual,
    found,
    status: outcome.status,
  };
  return outcome.reason === undefined ? base : { ...base, reason: outcome.reason };
}

function evaluateStatus(rule: AssertionRule, response: NormalizedResponse): AssertionDetail {
  const expected = Number(rule.expectedValue);
  const actual = response.statusCode;
  return detail(rule, actual, true, { status: actual === expected ? 'PASS' : 'FAIL' });
}

function evaluateLatency(rule: AssertionRule, response: NormalizedResponse): AssertionDetail {
  const expected = Number(rule.expectedValue);
  const actual = response.responseTimeMs;
  return detail(rule, actual, true, { status: actual <= expected ? 'PASS' : 'FAIL' });
}

function evaluateBodyPath(rule: AssertionRule, response: NormalizedResponse): AssertionDetail {
  // Truncated or non-JSON bodies: every BODY_JSON_PATH fails (docs/04 §3).
  if (response.truncated || !response.bodyIsJson) {
    return detail(rule, MISSING, false, {
      status: 'FAIL',
      reason: response.truncated ? REASON.truncated : REASON.notJson,
    });
  }

  const target = rule.target ?? '';
  const lookup = getJsonPath(response.body as JsonLike, target);

  if (rule.operator === 'exists') {
    return detail(rule, lookup.found ? lookup.value : null, lookup.found, {
      status: lookup.found ? 'PASS' : 'FAIL',
      ...(lookup.found ? {} : { reason: REASON.pathNotFound }),
    });
  }

  // A missing path always FAILs — including for not_equals (docs/04 §2).
  if (!lookup.found) {
    return detail(rule, MISSING, false, { status: 'FAIL', reason: REASON.pathNotFound });
  }

  if (rule.operator === 'equals' || rule.operator === 'not_equals') {
    return detail(rule, lookup.value, true, evaluateEquality(rule, lookup.value));
  }

  if (rule.operator === 'contains') {
    return detail(rule, lookup.value, true, contains(lookup.value, rule.expectedValue));
  }

  // Unreachable: the validator rejects operators outside the matrix.
  return detail(rule, lookup.value, true, { status: 'FAIL', reason: REASON.unsupportedContains });
}

function evaluateOne(rule: AssertionRule, response: NormalizedResponse): AssertionDetail {
  switch (rule.type) {
    case 'STATUS_CODE':
      return evaluateStatus(rule, response);
    case 'LATENCY':
      return evaluateLatency(rule, response);
    case 'BODY_JSON_PATH':
      return evaluateBodyPath(rule, response);
  }
}

export interface VerdictSummary {
  overallStatus: Verdict;
  assertionDetails: AssertionDetail[];
  passedCount: number;
  failedCount: number;
  totalAssertions: number;
}

/**
 * Pure function: normalised response + rules -> verdict breakdown.
 * Imports nothing from HTTP, DNS, or Fastify so it can be unit-tested offline.
 */
export function evaluate(response: NormalizedResponse, rules: AssertionRule[]): VerdictSummary {
  const assertionDetails = rules.map((rule) => evaluateOne(rule, response));
  const passedCount = assertionDetails.filter((d) => d.status === 'PASS').length;
  const failedCount = assertionDetails.length - passedCount;

  return {
    overallStatus: failedCount === 0 && assertionDetails.length > 0 ? 'PASS' : 'FAIL',
    assertionDetails,
    passedCount,
    failedCount,
    totalAssertions: assertionDetails.length,
  };
}
