export interface PathLookup {
  found: boolean;
  value: unknown;
}

/**
 * Resolve a simple dot-notation path against a parsed JSON value.
 *
 * v1 constraints (docs/04 §2 "Aturan Target Property Path"):
 * - case-sensitive
 * - no literal-dot keys
 * - no array indexing (`items[0]` out of scope)
 */
export function getJsonPath(root: unknown, path: string): PathLookup {
  if (path === '') return { found: false, value: undefined };

  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (typeof current !== 'object') return { found: false, value: undefined };
    if (Array.isArray(current)) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return { found: true, value: current };
}
