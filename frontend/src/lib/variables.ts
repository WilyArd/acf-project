import type {
  AssertionDraft,
  AssertionRule,
  Environment,
  EnvVariable,
  EnvVarType,
  ExecutePayload,
  HttpMethod,
  KeyValueRow,
} from '../types/api';

const PLACEHOLDER_REGEX = /\{\{([^{}]+)\}\}/g;
const MASKED_SECRET_PLACEHOLDER = '********';

export interface SubstituteOptions {
  maskSecrets?: boolean;
  allowResponseFallback?: boolean;
}

const COMMON_TOKEN_PATHS = [
  'data.token',
  'token',
  'data.access_token',
  'access_token',
  'data.accessToken',
  'accessToken',
] as const;

export interface PathLookupResult {
  found: boolean;
  value: unknown;
}

export interface ResolvedVariableRef {
  rawToken: string;
  name: string;
  scope: 'environment' | 'passthrough' | 'unresolved';
  resolvedValue: string | null;
  isSecret: boolean;
}

export interface TemplateSubstitutionResult {
  resolved: string;
  unresolved: string[];
  references: ResolvedVariableRef[];
}

/**
 * Resolve simple dot-notation paths matching backend/src/core/assertion/getJsonPath.ts.
 */
export function lookupDotPath(root: unknown, rawPath: string): PathLookupResult {
  const path = rawPath.trim();
  if (path === '') return { found: false, value: undefined };

  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (typeof current !== 'object' || Array.isArray(current)) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/**
 * Automatically locate a string JWT/access token in common REST login response shapes.
 */
export function extractAutoToken(body: unknown): { path: string; value: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  for (const path of COMMON_TOKEN_PATHS) {
    const res = lookupDotPath(body, path);
    if (res.found && typeof res.value === 'string' && res.value.trim() !== '') {
      return { path, value: res.value };
    }
  }
  return null;
}

/**
 * Safely switch an Environment variable between 'default' and 'secret'
 * without losing a value that only lived in initialValue.
 */
export function transitionEnvVarType(variable: EnvVariable, nextType: EnvVarType): EnvVariable {
  if (nextType === 'secret') {
    const preserved = variable.currentValue !== '' ? variable.currentValue : variable.initialValue;
    return {
      ...variable,
      type: 'secret',
      initialValue: '',
      currentValue: preserved,
    };
  }
  // Never promote a secret's currentValue into exportable initialValue on downgrade.
  if (variable.type === 'secret') {
    return {
      ...variable,
      type: 'default',
      initialValue: '',
    };
  }
  return {
    ...variable,
    type: 'default',
    initialValue: variable.initialValue !== '' ? variable.initialValue : variable.currentValue,
  };
}

export function extractPlaceholderNames(input: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  while ((match = regex.exec(input)) !== null) {
    const name = match[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

export function substituteTemplate(
  input: string,
  activeEnv: Environment | null,
  lastResponseBody: unknown,
  manualPassthroughToken?: { path: string; value: string } | null,
  options?: SubstituteOptions,
): TemplateSubstitutionResult {
  const mask = Boolean(options?.maskSecrets);
  const allowFallback = options?.allowResponseFallback ?? true;

  const envMap = new Map<string, { value: string; isSecret: boolean }>();
  if (activeEnv) {
    for (const v of activeEnv.variables) {
      if (!v.enabled || !v.key.trim()) continue;
      const effectiveValue = v.currentValue !== '' ? v.currentValue : v.initialValue;
      envMap.set(v.key.trim(), { value: effectiveValue, isSecret: v.type === 'secret' });
    }
  }

  const unresolvedSet = new Set<string>();
  const refMap = new Map<string, ResolvedVariableRef>();

  const resolved = input.replace(PLACEHOLDER_REGEX, (fullMatch, rawInner: string) => {
    const name = rawInner.trim();
    if (!name) return fullMatch;

    if (name.startsWith('$.')) {
      const dotPath = name.slice(2);
      if (manualPassthroughToken && manualPassthroughToken.path === dotPath) {
        refMap.set(name, {
          rawToken: fullMatch,
          name,
          scope: 'passthrough',
          resolvedValue: manualPassthroughToken.value,
          isSecret: true,
        });
        return mask ? MASKED_SECRET_PLACEHOLDER : manualPassthroughToken.value;
      }
      if (allowFallback) {
        const lookup = lookupDotPath(lastResponseBody, dotPath);
        if (lookup.found && lookup.value !== null && lookup.value !== undefined && typeof lookup.value !== 'object') {
          const strVal = String(lookup.value);
          refMap.set(name, {
            rawToken: fullMatch,
            name,
            scope: 'passthrough',
            resolvedValue: strVal,
            isSecret: true,
          });
          return mask ? MASKED_SECRET_PLACEHOLDER : strVal;
        }
      }
      unresolvedSet.add(name);
      refMap.set(name, {
        rawToken: fullMatch,
        name,
        scope: 'unresolved',
        resolvedValue: null,
        isSecret: false,
      });
      return fullMatch;
    }

    const envEntry = envMap.get(name);
    if (envEntry !== undefined) {
      refMap.set(name, {
        rawToken: fullMatch,
        name,
        scope: 'environment',
        resolvedValue: envEntry.value,
        isSecret: envEntry.isSecret,
      });
      return mask && envEntry.isSecret ? MASKED_SECRET_PLACEHOLDER : envEntry.value;
    }

    unresolvedSet.add(name);
    refMap.set(name, {
      rawToken: fullMatch,
      name,
      scope: 'unresolved',
      resolvedValue: null,
      isSecret: false,
    });
    return fullMatch;
  });

  return {
    resolved,
    unresolved: Array.from(unresolvedSet),
    references: Array.from(refMap.values()),
  };
}

/**
 * Normalize accidental double-slashes in the URL path caused by `{{url}}/` + `/api/...`
 * while preserving the scheme `https://` and query string verbatim.
 */
export function normalizeUrlPathSlashes(url: string): string {
  const match = url.match(/^(https?:\/\/[^/?#]+)([^?#]*)(.*)$/i);
  if (!match) return url;
  const [, origin, pathname, rest] = match;
  const cleanPath = pathname.replace(/\/{2,}/g, '/');
  return `${origin}${cleanPath}${rest}`;
}

/**
 * One-way query parameter append matching backend/src/services/validator.ts.
 * Does NOT parse the URL bar back into the query table.
 */
export function buildPreviewUrl(baseUrl: string, queryParams: Record<string, string>): string {
  const trimmed = normalizeUrlPathSlashes(baseUrl.trim());
  if (!trimmed) return '';
  if (Object.keys(queryParams).length === 0) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const search = new URLSearchParams(parsed.search);
    for (const [k, v] of Object.entries(queryParams)) {
      search.set(k, v);
    }
    parsed.search = search.toString();
    return parsed.toString();
  } catch {
    const sep = trimmed.includes('?') ? '&' : '?';
    const qs = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return `${trimmed}${sep}${qs}`;
  }
}

export function collectRequestVariableRefs(params: {
  url: string;
  queryParams: KeyValueRow[];
  headers: KeyValueRow[];
  bodyText: string;
  assertions?: AssertionDraft[];
  method: HttpMethod;
  activeEnv: Environment | null;
  lastResponseBody: unknown;
  manualPassthroughToken?: { path: string; value: string } | null;
  allowResponseFallback?: boolean;
}): { references: ResolvedVariableRef[]; unresolved: string[]; resolvedUrl: string } {
  const {
    url,
    queryParams,
    headers,
    bodyText,
    assertions,
    method,
    activeEnv,
    lastResponseBody,
    manualPassthroughToken,
    allowResponseFallback = true,
  } = params;
  const allRefs = new Map<string, ResolvedVariableRef>();
  const unresolved = new Set<string>();

  const trackPreview = (text: string) => {
    const res = substituteTemplate(text, activeEnv, lastResponseBody, manualPassthroughToken, {
      maskSecrets: true,
      allowResponseFallback,
    });
    for (const r of res.references) allRefs.set(r.name, r);
    for (const u of res.unresolved) unresolved.add(u);
    return res.resolved;
  };

  const resolvedBaseUrl = normalizeUrlPathSlashes(trackPreview(url));
  const resolvedQueryObj: Record<string, string> = {};
  for (const row of queryParams) {
    if (!row.enabled || !row.key.trim()) continue;
    resolvedQueryObj[row.key.trim()] = trackPreview(row.value);
  }
  for (const row of headers) {
    if (!row.enabled || !row.key.trim()) continue;
    trackPreview(row.value);
  }
  if (method !== 'GET' && bodyText.trim()) {
    trackPreview(bodyText);
  }
  for (const asrt of assertions ?? []) {
    if (!asrt.enabled || asrt.type !== 'BODY_JSON_PATH' || asrt.operator === 'exists') continue;
    if (asrt.expectedInput) trackPreview(asrt.expectedInput);
  }

  return {
    references: Array.from(allRefs.values()),
    unresolved: Array.from(unresolved),
    resolvedUrl: buildPreviewUrl(resolvedBaseUrl, resolvedQueryObj),
  };
}

export function parseJsonBodyText(bodyText: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = bodyText.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sintaks JSON tidak valid.';
    return { ok: false, error: message };
  }
}

function scanJsonTemplate(
  trimmed: string,
  onPlaceholder: (rawToken: string, rawInner: string, insideString: boolean) => string,
): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        i += 1;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '{' && trimmed[i + 1] === '{') {
        const closeIdx = trimmed.indexOf('}}', i + 2);
        if (closeIdx !== -1 && !trimmed.slice(i + 2, closeIdx).includes('{')) {
          const rawToken = trimmed.slice(i, closeIdx + 2);
          const rawInner = trimmed.slice(i + 2, closeIdx);
          out += onPlaceholder(rawToken, rawInner, true);
          i = closeIdx + 2;
          continue;
        }
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '{' && trimmed[i + 1] === '{') {
      const closeIdx = trimmed.indexOf('}}', i + 2);
      if (closeIdx !== -1 && !trimmed.slice(i + 2, closeIdx).includes('{')) {
        const rawToken = trimmed.slice(i, closeIdx + 2);
        const rawInner = trimmed.slice(i + 2, closeIdx);
        out += onPlaceholder(rawToken, rawInner, false);
        i = closeIdx + 2;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function substituteJsonBodyTemplate(
  bodyText: string,
  activeEnv: Environment | null,
  lastResponseBody: unknown,
  manualPassthroughToken?: { path: string; value: string } | null,
  allowResponseFallback = true,
): { ok: true; resolved: string; unresolved: string[] } | { ok: false; error: string; unresolved?: string[] } {
  const unresolvedSet = new Set<string>();
  let unquotedError: string | null = null;

  const resolved = scanJsonTemplate(bodyText, (rawToken, rawInner, insideString) => {
    const name = rawInner.trim();
    if (!name) return rawToken;

    const sub = substituteTemplate(rawToken, activeEnv, lastResponseBody, manualPassthroughToken, {
      allowResponseFallback,
    });
    if (sub.unresolved.length > 0) {
      sub.unresolved.forEach((u) => unresolvedSet.add(u));
      return rawToken;
    }

    if (insideString) {
      // Escape inserted string safely so credentials/tokens cannot break out of JSON strings.
      return JSON.stringify(sub.resolved).slice(1, -1);
    }

    const candidate = sub.resolved.trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      if (!unquotedError) {
        unquotedError = `Nilai variabel "{{${name}}}" di luar tanda kutip bukan literal JSON yang valid (gunakan tanda kutip atau angka/boolean/null).`;
      }
      return rawToken;
    }
  });

  if (unquotedError && unresolvedSet.size === 0) {
    return { ok: false, error: unquotedError };
  }
  return { ok: true, resolved, unresolved: Array.from(unresolvedSet) };
}

/**
 * Validate JSON body syntax while tolerating both quoted ("{{name}}")
 * and unquoted ({{user_id}}) template placeholders.
 */
export function validateJsonTemplateSyntax(
  bodyText: string,
  activeEnv: Environment | null = null,
  lastResponseBody: unknown = null,
  manualPassthroughToken?: { path: string; value: string } | null,
  allowResponseFallback = true,
): { ok: true } | { ok: false; error: string } {
  const trimmed = bodyText.trim();
  if (trimmed === '') return { ok: true };

  if (activeEnv || lastResponseBody || manualPassthroughToken) {
    const sub = substituteJsonBodyTemplate(
      trimmed,
      activeEnv,
      lastResponseBody,
      manualPassthroughToken,
      allowResponseFallback,
    );
    if (!sub.ok) return { ok: false, error: sub.error };
    if (sub.unresolved.length === 0) {
      const parsed = parseJsonBodyText(sub.resolved);
      return parsed.ok ? { ok: true } : parsed;
    }
  }

  const sanitized = scanJsonTemplate(trimmed, (rawToken, _rawInner, insideString) =>
    insideString ? rawToken : '0',
  );

  const parsed = parseJsonBodyText(sanitized);
  return parsed.ok ? { ok: true } : parsed;
}

export function normalizeAssertionTarget(rawTarget: string): string {
  return rawTarget.trim().replace(/^\$\.?/, '').replace(/^\.+/, '');
}

export function convertAssertionDrafts(
  drafts: AssertionDraft[],
  resolveExpected?: (raw: string) => string,
):
  | { ok: true; assertions: AssertionRule[] }
  | { ok: false; error: string } {
  const active = drafts.filter((d) => d.enabled);
  if (active.length === 0) {
    return { ok: false, error: 'Minimal 1 assertion aktif wajib dikonfigurasi sebelum Execute.' };
  }

  const rules: AssertionRule[] = [];
  for (let i = 0; i < active.length; i += 1) {
    const d = active[i];
    if (d.type === 'STATUS_CODE') {
      const num = Number(d.expectedInput.trim());
      if (!d.expectedInput.trim() || !Number.isFinite(num)) {
        return { ok: false, error: `Assertion #${i + 1}: Expected STATUS_CODE harus berupa angka (mis. 200).` };
      }
      rules.push({ type: 'STATUS_CODE', operator: 'equals', target: null, expectedValue: num });
      continue;
    }
    if (d.type === 'LATENCY') {
      const num = Number(d.expectedInput.trim());
      if (!d.expectedInput.trim() || !Number.isFinite(num) || num <= 0) {
        return { ok: false, error: `Assertion #${i + 1}: Expected LATENCY harus berupa angka positif (ms).` };
      }
      rules.push({ type: 'LATENCY', operator: 'less_than_or_equal', target: null, expectedValue: num });
      continue;
    }

    const normalizedTarget = normalizeAssertionTarget(d.target);
    if (!normalizedTarget) {
      return { ok: false, error: `Assertion #${i + 1}: Target dot-path wajib diisi untuk BODY_JSON_PATH.` };
    }
    if (d.operator === 'exists') {
      rules.push({
        type: 'BODY_JSON_PATH',
        operator: 'exists',
        target: normalizedTarget,
        expectedValue: null,
      });
    } else {
      const expectedValue = resolveExpected ? resolveExpected(d.expectedInput) : d.expectedInput;
      rules.push({
        type: 'BODY_JSON_PATH',
        operator: d.operator,
        target: normalizedTarget,
        expectedValue,
      });
    }
  }
  return { ok: true, assertions: rules };
}

export function buildExecutePayload(params: {
  method: HttpMethod;
  url: string;
  queryParams: KeyValueRow[];
  headers: KeyValueRow[];
  bodyText: string;
  assertions: AssertionDraft[];
  activeEnv: Environment | null;
  lastResponseBody: unknown;
  manualPassthroughToken?: { path: string; value: string } | null;
  allowResponseFallback?: boolean;
}):
  | { ok: true; payload: ExecutePayload; resolvedFullUrl: string }
  | { ok: false; error: string; unresolved?: string[] } {
  const {
    method,
    url,
    queryParams,
    headers,
    bodyText,
    assertions,
    activeEnv,
    lastResponseBody,
    manualPassthroughToken,
    allowResponseFallback = true,
  } = params;

  const urlSub = substituteTemplate(url.trim(), activeEnv, lastResponseBody, manualPassthroughToken, {
    allowResponseFallback,
  });
  const unresolvedSet = new Set<string>(urlSub.unresolved);
  const cleanResolvedUrl = normalizeUrlPathSlashes(urlSub.resolved);

  const maskedUrlSub = substituteTemplate(url.trim(), activeEnv, lastResponseBody, manualPassthroughToken, {
    maskSecrets: true,
    allowResponseFallback,
  });
  const cleanMaskedUrl = normalizeUrlPathSlashes(maskedUrlSub.resolved);

  // Deduplicate query params (last enabled row wins)
  const resolvedQuery: Record<string, string> = {};
  for (const row of queryParams) {
    if (!row.enabled || !row.key.trim()) continue;
    const sub = substituteTemplate(row.value, activeEnv, lastResponseBody, manualPassthroughToken, {
      allowResponseFallback,
    });
    sub.unresolved.forEach((u) => unresolvedSet.add(u));
    resolvedQuery[row.key.trim()] = sub.resolved;
  }

  // Case-insensitive deduplication for HTTP headers (last enabled row wins)
  const resolvedHeaders: Record<string, string> = {};
  const headerCanonicalKey = new Map<string, string>();
  for (const row of headers) {
    if (!row.enabled || !row.key.trim()) continue;
    const rawKey = row.key.trim();
    const lower = rawKey.toLowerCase();
    const prevKey = headerCanonicalKey.get(lower);
    if (prevKey && prevKey !== rawKey) {
      delete resolvedHeaders[prevKey];
    }
    headerCanonicalKey.set(lower, rawKey);
    const sub = substituteTemplate(row.value, activeEnv, lastResponseBody, manualPassthroughToken, {
      allowResponseFallback,
    });
    sub.unresolved.forEach((u) => unresolvedSet.add(u));
    resolvedHeaders[rawKey] = sub.resolved;
  }

  let parsedBody: unknown = undefined;
  if (method !== 'GET' && bodyText.trim() !== '') {
    const bodySub = substituteJsonBodyTemplate(
      bodyText,
      activeEnv,
      lastResponseBody,
      manualPassthroughToken,
      allowResponseFallback,
    );
    if (!bodySub.ok) {
      return { ok: false, error: bodySub.error };
    }
    bodySub.unresolved.forEach((u) => unresolvedSet.add(u));
    if (bodySub.unresolved.length === 0) {
      const parsed = parseJsonBodyText(bodySub.resolved);
      if (!parsed.ok) {
        return { ok: false, error: `Body JSON tidak valid: ${parsed.error}` };
      }
      parsedBody = parsed.value;
    }
  }

  const assertionResult = convertAssertionDrafts(assertions, (rawExpected) => {
    const sub = substituteTemplate(rawExpected, activeEnv, lastResponseBody, manualPassthroughToken, {
      allowResponseFallback,
    });
    sub.unresolved.forEach((u) => unresolvedSet.add(u));
    return sub.resolved;
  });

  if (unresolvedSet.size > 0) {
    const list = Array.from(unresolvedSet);
    return {
      ok: false,
      error: `Variabel belum terdefinisi: ${list.map((v) => `{{${v}}}`).join(', ')}. Pilih Environment aktif atau definisikan nilainya terlebih dahulu.`,
      unresolved: list,
    };
  }

  if (!/^https?:\/\/.+/i.test(cleanResolvedUrl)) {
    return {
      ok: false,
      error: 'URL wajib dimulai dengan http:// atau https:// dan memuat host yang valid.',
    };
  }

  try {
    new URL(cleanResolvedUrl);
  } catch {
    return { ok: false, error: 'Format URL tidak valid untuk diparse.' };
  }

  if (!assertionResult.ok) {
    return { ok: false, error: assertionResult.error };
  }

  const payload: ExecutePayload = {
    request: {
      method,
      url: cleanResolvedUrl,
      headers: resolvedHeaders,
      queryParams: resolvedQuery,
      ...(method === 'GET' || parsedBody === undefined ? {} : { body: parsedBody }),
    },
    assertions: assertionResult.assertions,
  };

  // Keep resolvedFullUrl strictly safe for history/display (origin + pathname only, masked secrets).
  let safeDisplayUrl = cleanMaskedUrl;
  try {
    const u = new URL(cleanMaskedUrl);
    safeDisplayUrl = `${u.origin}${u.pathname}`;
  } catch {
    safeDisplayUrl = cleanMaskedUrl.split(/[?#]/)[0] ?? cleanMaskedUrl;
  }

  return {
    ok: true,
    payload,
    resolvedFullUrl: safeDisplayUrl,
  };
}

export function maskSecret(value: string): string {
  if (!value) return '(kosong)';
  const len = Math.min(Math.max(value.length, 8), 20);
  return '*'.repeat(len);
}
