import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getJsonPath } from '../src/core/assertion/getJsonPath.js';

describe('getJsonPath', () => {
  it('resolves a top-level key', () => {
    assert.deepEqual(getJsonPath({ status: 'success' }, 'status'), { found: true, value: 'success' });
  });

  it('resolves a nested path', () => {
    const data = { data: { user: { id: 7 } } };
    assert.deepEqual(getJsonPath(data, 'data.user.id'), { found: true, value: 7 });
  });

  it('distinguishes a null value from a missing key', () => {
    assert.deepEqual(getJsonPath({ token: null }, 'token'), { found: true, value: null });
    assert.equal(getJsonPath({}, 'token').found, false);
  });

  it('is case-sensitive', () => {
    assert.equal(getJsonPath({ Status: 'ok' }, 'status').found, false);
  });

  it('does not index arrays (out of scope v1)', () => {
    assert.equal(getJsonPath({ items: [{ id: 1 }] }, 'items.0.id').found, false);
  });

  it('returns not found when traversing a primitive', () => {
    assert.equal(getJsonPath({ data: 'text' }, 'data.id').found, false);
  });

  it('returns not found for an empty path', () => {
    assert.equal(getJsonPath({ a: 1 }, '').found, false);
  });

  it('does not walk inherited properties', () => {
    assert.equal(getJsonPath({}, 'toString').found, false);
  });
});
