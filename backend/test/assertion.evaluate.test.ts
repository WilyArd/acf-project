import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REASON, evaluate } from '../src/core/assertion/evaluate.js';
import type { AssertionRule, NormalizedResponse } from '../src/models/types.js';

function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    statusCode: 200,
    responseTimeMs: 142,
    bodySizeBytes: 100,
    truncated: false,
    headers: {},
    body: { status: 'success', data: { token: null } },
    bodyIsJson: true,
    ...overrides,
  };
}

function one(rule: AssertionRule, res: NormalizedResponse = response()) {
  return evaluate(res, [rule]).assertionDetails[0]!;
}

describe('STATUS_CODE', () => {
  it('passes when equal', () => {
    const detail = one({ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 });
    assert.equal(detail.status, 'PASS');
    assert.equal(detail.found, true);
    assert.equal(detail.target, null);
    assert.equal(detail.actual, 200);
  });

  it('fails when different', () => {
    assert.equal(one({ type: 'STATUS_CODE', operator: 'equals', expectedValue: 404 }).status, 'FAIL');
  });
});

describe('LATENCY', () => {
  it('passes when within limit', () => {
    const detail = one({ type: 'LATENCY', operator: 'less_than_or_equal', expectedValue: 500 });
    assert.equal(detail.status, 'PASS');
    assert.equal(detail.actual, 142);
    assert.equal(detail.target, null);
  });

  it('passes on the exact boundary', () => {
    const detail = one(
      { type: 'LATENCY', operator: 'less_than_or_equal', expectedValue: 142 },
      response({ responseTimeMs: 142 }),
    );
    assert.equal(detail.status, 'PASS');
  });

  it('fails above the limit', () => {
    const detail = one(
      { type: 'LATENCY', operator: 'less_than_or_equal', expectedValue: 100 },
      response({ responseTimeMs: 101 }),
    );
    assert.equal(detail.status, 'FAIL');
  });
});

describe('BODY_JSON_PATH equals/not_equals', () => {
  it('normalises number and string', () => {
    const res = response({ body: { id: 1 } });
    assert.equal(one({ type: 'BODY_JSON_PATH', operator: 'equals', target: 'id', expectedValue: '1' }, res).status, 'PASS');
    assert.equal(one({ type: 'BODY_JSON_PATH', operator: 'not_equals', target: 'id', expectedValue: '2' }, res).status, 'PASS');
  });

  it('treats null as equal to the string "null"', () => {
    const res = response({ body: { v: null } });
    const detail = one({ type: 'BODY_JSON_PATH', operator: 'equals', target: 'v', expectedValue: 'null' }, res);
    assert.equal(detail.status, 'PASS');
    assert.equal(detail.found, true);
    assert.equal(detail.actual, null);
  });

  it('treats true as equal to the string "true"', () => {
    const res = response({ body: { v: true } });
    assert.equal(one({ type: 'BODY_JSON_PATH', operator: 'equals', target: 'v', expectedValue: 'true' }, res).status, 'PASS');
  });

  it('rejects object actual with the documented reason', () => {
    const res = response({ body: { v: { a: 1 } } });
    const detail = one({ type: 'BODY_JSON_PATH', operator: 'equals', target: 'v', expectedValue: '[object Object]' }, res);
    assert.equal(detail.status, 'FAIL');
    assert.equal(detail.reason, REASON.unsupportedEquals);
  });

  it('rejects array actual with the documented reason', () => {
    const res = response({ body: { v: [1, 2] } });
    const detail = one({ type: 'BODY_JSON_PATH', operator: 'not_equals', target: 'v', expectedValue: 'x' }, res);
    assert.equal(detail.status, 'FAIL');
    assert.equal(detail.reason, REASON.unsupportedEquals);
  });

  it('fails a missing path for equals', () => {
    const detail = one({ type: 'BODY_JSON_PATH', operator: 'equals', target: 'nope', expectedValue: 'x' });
    assert.equal(detail.status, 'FAIL');
    assert.equal(detail.found, false);
    assert.equal(detail.actual, null);
    assert.equal(detail.reason, 'path tidak ditemukan');
  });

  it('fails a missing path for not_equals (never passes silently)', () => {
    const detail = one({ type: 'BODY_JSON_PATH', operator: 'not_equals', target: 'nope', expectedValue: 'x' });
    assert.equal(detail.status, 'FAIL');
    assert.equal(detail.reason, 'path tidak ditemukan');
  });
});

describe('BODY_JSON_PATH contains', () => {
  it('matches a substring in a string', () => {
    const res = response({ body: { msg: 'hello world' } });
    assert.equal(one({ type: 'BODY_JSON_PATH', operator: 'contains', target: 'msg', expectedValue: 'world' }, res).status, 'PASS');
    assert.equal(one({ type: 'BODY_JSON_PATH', operator: 'contains', target: 'msg', expectedValue: 'zzz' }, res).status, 'FAIL');
  });

  it('matches membership in an array', () => {
    const res = response({ body: { roles: ['admin', 'user'] } });
    assert.equal(one({ type: 'BODY_JSON_PATH', operator: 'contains', target: 'roles', expectedValue: 'admin' }, res).status, 'PASS');
    assert.equal(one({ type: 'BODY_JSON_PATH', operator: 'contains', target: 'roles', expectedValue: 'root' }, res).status, 'FAIL');
  });

  it('rejects unsupported actual types', () => {
    for (const value of [42, true, null, { a: 1 }]) {
      const res = response({ body: { v: value } });
      const detail = one({ type: 'BODY_JSON_PATH', operator: 'contains', target: 'v', expectedValue: 'x' }, res);
      assert.equal(detail.status, 'FAIL');
      assert.equal(detail.reason, REASON.unsupportedContains);
    }
  });
});

describe('BODY_JSON_PATH exists', () => {
  it('passes when the key holds null', () => {
    const detail = one({ type: 'BODY_JSON_PATH', operator: 'exists', target: 'data.token', expectedValue: null });
    assert.equal(detail.status, 'PASS');
    assert.equal(detail.found, true);
    assert.equal(detail.actual, null);
    assert.equal(detail.expected, null);
  });

  it('fails when the key is absent', () => {
    const detail = one(
      { type: 'BODY_JSON_PATH', operator: 'exists', target: 'data.token', expectedValue: null },
      response({ body: { data: {} } }),
    );
    assert.equal(detail.status, 'FAIL');
    assert.equal(detail.found, false);
    assert.equal(detail.actual, null);
  });
});

describe('non-JSON and truncated bodies', () => {
  it('fails every BODY_JSON_PATH when the body is not JSON', () => {
    const res = response({ body: '<html>', bodyIsJson: false });
    const detail = one({ type: 'BODY_JSON_PATH', operator: 'exists', target: 'a', expectedValue: null }, res);
    assert.equal(detail.status, 'FAIL');
    assert.equal(detail.found, false);
    assert.equal(detail.reason, REASON.notJson);
  });

  it('uses the truncation reason when truncated', () => {
    const res = response({ body: '{"a":', bodyIsJson: false, truncated: true });
    const detail = one({ type: 'BODY_JSON_PATH', operator: 'exists', target: 'a', expectedValue: null }, res);
    assert.equal(detail.status, 'FAIL');
    assert.equal(detail.reason, REASON.truncated);
  });

  it('still evaluates STATUS_CODE and LATENCY', () => {
    const res = response({ body: 'not json', bodyIsJson: false });
    const summary = evaluate(
      res,
      [
        { type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 },
        { type: 'LATENCY', operator: 'less_than_or_equal', expectedValue: 500 },
        { type: 'BODY_JSON_PATH', operator: 'exists', target: 'a', expectedValue: null },
      ],
    );
    assert.equal(summary.passedCount, 2);
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.overallStatus, 'FAIL');
  });
});

describe('overall verdict', () => {
  it('is PASS when every assertion passes', () => {
    const summary = evaluate(response(), [
      { type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 },
      { type: 'LATENCY', operator: 'less_than_or_equal', expectedValue: 500 },
    ]);
    assert.equal(summary.overallStatus, 'PASS');
    assert.equal(summary.totalAssertions, 2);
  });

  it('is FAIL when at least one fails', () => {
    const summary = evaluate(response(), [
      { type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 },
      { type: 'STATUS_CODE', operator: 'equals', expectedValue: 404 },
    ]);
    assert.equal(summary.overallStatus, 'FAIL');
    assert.equal(summary.passedCount, 1);
    assert.equal(summary.failedCount, 1);
  });

  it('keeps target null for non-path assertions', () => {
    const summary = evaluate(response(), [{ type: 'STATUS_CODE', operator: 'equals', expectedValue: 200 }]);
    assert.equal(summary.assertionDetails[0]!.target, null);
    assert.ok(!('reason' in summary.assertionDetails[0]!));
  });

  it('never throws on objects with shadowed/null toString/valueOf', () => {
    const poison = { toString: null, valueOf: null };
    const eqDetail = one(
      { type: 'BODY_JSON_PATH', operator: 'equals', target: 'data.id', expectedValue: poison },
      response({ body: { data: { id: 1 } } }),
    );
    const arrDetail = one(
      { type: 'BODY_JSON_PATH', operator: 'contains', target: 'items', expectedValue: '[object Object]' },
      response({ body: { items: [{ nested: true }] } }),
    );
    assert.equal(eqDetail.status, 'FAIL');
    assert.equal(arrDetail.status, 'FAIL');
  });
});
