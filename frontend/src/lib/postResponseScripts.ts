import type {
  Environment,
  EnvVariable,
  KeyValueRow,
  PostResponseVarRule,
} from '../types/api';
import { lookupDotPath, substituteTemplate } from './variables';

const MAX_SCRIPT_CHARS = 65_536;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[_-]?key|auth|bearer|private)/i;
const JWT_SHAPE_REGEX = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/;

let varIdSeq = 1;
function nextRuleVarId(): string {
  varIdSeq += 1;
  return `envv_sync_${Date.now().toString(36)}_${varIdSeq}`;
}

function normalizeBracketSegments(expr: string): string {
  return expr
    .trim()
    .replace(/\[['"]([A-Za-z0-9_$-]+)['"]\]/g, '.$1')
    .replace(/\.{2,}/g, '.');
}

function stripResponseRootPrefix(
  normalizedExpr: string,
  jsonAliases: Set<string>,
): string | null {
  const cleaned = normalizedExpr.replace(/^\(\s*|\s*\)$/g, '').trim();
  const rootPatterns = [
    'pm.response.json().',
    'JSON.parse(responseBody).',
    'res.getBody().',
    'res.body.',
  ];
  for (const prefix of rootPatterns) {
    if (cleaned.startsWith(prefix)) {
      const rest = cleaned.slice(prefix.length).replace(/^\.+/, '');
      return rest || null;
    }
  }
  for (const alias of jsonAliases) {
    if (cleaned === alias) return '';
    if (cleaned.startsWith(`${alias}.`)) {
      const rest = cleaned.slice(alias.length + 1).replace(/^\.+/, '');
      return rest || null;
    }
  }
  return null;
}

function parseAssignmentRhs(
  rawRhs: string,
  jsonAliases: Set<string>,
): { sourcePath: string; prefix?: string } | null {
  const rhs = rawRhs.trim().replace(/;+\s*$/, '').trim();
  if (!rhs) return null;

  // Case 1: Template literal e.g. `Bearer ${jsonData.data.access_token}`
  const tplMatch = rhs.match(/^`([^`]*?)\$\{\s*([^}]+)\s*\}([^`]*)`$/);
  if (tplMatch) {
    const [, prefixText, innerExpr, suffixText] = tplMatch;
    if (suffixText === '') {
      const path = stripResponseRootPrefix(normalizeBracketSegments(innerExpr), jsonAliases);
      if (path) {
        return prefixText ? { sourcePath: path, prefix: prefixText } : { sourcePath: path };
      }
    }
  }

  // Case 2: String literal concatenation e.g. "Bearer " + jsonData.data.access_token
  const concatMatch = rhs.match(/^(?:"([^"]*)"|'([^']*)')\s*\+\s*(.+)$/);
  if (concatMatch) {
    const prefixText = concatMatch[1] ?? concatMatch[2] ?? '';
    const expr = normalizeBracketSegments(concatMatch[3]);
    const path = stripResponseRootPrefix(expr, jsonAliases);
    if (path) {
      return prefixText ? { sourcePath: path, prefix: prefixText } : { sourcePath: path };
    }
  }

  // Case 3: Direct property path e.g. jsonData.data.access_token or pm.response.json().data.token
  const path = stripResponseRootPrefix(normalizeBracketSegments(rhs), jsonAliases);
  if (path) {
    return { sourcePath: path };
  }

  return null;
}

/**
 * Safely parse common Postman / Bruno post-response variable assignment statements
 * without executing any JavaScript (`eval`-free declarative extraction).
 */
export function extractPostResponseVarRulesFromScript(scriptText: string): {
  rules: PostResponseVarRule[];
  hasUnhandledScripts: boolean;
} {
  if (!scriptText || !scriptText.trim()) {
    return { rules: [], hasUnhandledScripts: false };
  }

  const bounded = scriptText.slice(0, MAX_SCRIPT_CHARS);
  const jsonAliases = new Set<string>(['responseJson', 'jsonData', 'resBody']);

  // Collect response JSON variable aliases: const data = pm.response.json() / JSON.parse(responseBody) / res.body / res.getBody()
  const aliasRegex =
    /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*(?:responseBody|pm\.response\.text\(\))\s*\)|res\.getBody\(\)|res\.body\b)/g;
  let aliasMatch: RegExpExecArray | null;
  while ((aliasMatch = aliasRegex.exec(bounded)) !== null) {
    if (aliasMatch[1]) jsonAliases.add(aliasMatch[1]);
  }

  const rules: PostResponseVarRule[] = [];
  const seenKey = new Set<string>();

  const lines = bounded.split(/\r?\n/);
  let meaningfulStatements = 0;
  let matchedStatements = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }
    meaningfulStatements += 1;

    const setterMatch = trimmed.match(
      /^(pm\.environment\.set|pm\.globals\.set|pm\.collectionVariables\.set|postman\.setEnvironmentVariable|bru\.setEnvVar|bru\.setVar)\(\s*(?:"([^"]+)"|'([^']+)')\s*,\s*(.+?)\)\s*;?$/,
    );
    if (!setterMatch) {
      // Alias declaration lines don't count as unhandled noise when rules match around them
      if (
        /^(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(|res\.getBody\(\)|res\.body)/.test(
          trimmed,
        )
      ) {
        matchedStatements += 1;
      }
      continue;
    }

    const fnName = setterMatch[1];
    const varName = (setterMatch[2] ?? setterMatch[3] ?? '').trim();
    const rawRhs = setterMatch[4];
    if (!varName || FORBIDDEN_KEYS.has(varName)) continue;

    const parsedRhs = parseAssignmentRhs(rawRhs, jsonAliases);
    if (!parsedRhs) continue;

    matchedStatements += 1;
    const target: 'environment' | 'collection' =
      fnName === 'pm.collectionVariables.set' || fnName === 'bru.setVar'
        ? 'collection'
        : 'environment';

    const dedupeKey = `${target}:${varName}`;
    if (seenKey.has(dedupeKey)) {
      const idx = rules.findIndex((r) => `${r.target}:${r.varName}` === dedupeKey);
      if (idx >= 0) {
        rules[idx] = { target, varName, sourcePath: parsedRhs.sourcePath, ...(parsedRhs.prefix ? { prefix: parsedRhs.prefix } : {}) };
      }
    } else {
      seenKey.add(dedupeKey);
      rules.push({
        target,
        varName,
        sourcePath: parsedRhs.sourcePath,
        ...(parsedRhs.prefix ? { prefix: parsedRhs.prefix } : {}),
      });
    }
  }

  return {
    rules,
    hasUnhandledScripts: meaningfulStatements > matchedStatements,
  };
}

export function extractPostResponseVarRulesFromPostmanEvents(events: unknown): {
  rules: PostResponseVarRule[];
  hasUnhandledScripts: boolean;
} {
  if (!Array.isArray(events) || events.length === 0) {
    return { rules: [], hasUnhandledScripts: false };
  }

  const allRules: PostResponseVarRule[] = [];
  let hasUnhandledScripts = false;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const typed = ev as { listen?: string; script?: { exec?: string[] | string } };
    const execText = Array.isArray(typed.script?.exec)
      ? typed.script.exec.join('\n')
      : typeof typed.script?.exec === 'string'
        ? typed.script.exec
        : '';
    if (!execText.trim()) continue;

    if (typed.listen && typed.listen !== 'test') {
      hasUnhandledScripts = true;
      continue;
    }

    const res = extractPostResponseVarRulesFromScript(execText);
    for (const r of res.rules) {
      const idx = allRules.findIndex((prev) => prev.varName === r.varName && prev.target === r.target);
      if (idx >= 0) allRules[idx] = r;
      else allRules.push(r);
    }
    if (res.hasUnhandledScripts) hasUnhandledScripts = true;
  }

  return { rules: allRules, hasUnhandledScripts };
}

export function applyPostResponseVarRulesToEnv(
  env: Environment,
  rules: PostResponseVarRule[],
  responseBody: unknown,
  statusCode: number,
): {
  updatedEnv: Environment;
  applied: Array<{ varName: string; path: string; hasBearerPrefix: boolean }>;
} {
  if (
    statusCode < 200 ||
    statusCode >= 300 ||
    rules.length === 0 ||
    typeof responseBody !== 'object' ||
    responseBody === null
  ) {
    return { updatedEnv: env, applied: [] };
  }

  let nextVars = [...env.variables];
  const applied: Array<{ varName: string; path: string; hasBearerPrefix: boolean }> = [];

  for (const rule of rules) {
    if (FORBIDDEN_KEYS.has(rule.varName)) continue;
    const lookup = lookupDotPath(responseBody, rule.sourcePath);
    if (
      !lookup.found ||
      lookup.value === null ||
      lookup.value === undefined ||
      typeof lookup.value === 'object'
    ) {
      continue;
    }

    const rawStr = String(lookup.value);
    const prefix = rule.prefix ?? '';
    const nextValue =
      prefix.toLowerCase() === 'bearer ' && /^bearer\s+/i.test(rawStr)
        ? rawStr
        : `${prefix}${rawStr}`;

    const existingIdx = nextVars.findIndex((v) => v.key.trim() === rule.varName);
    if (existingIdx >= 0) {
      const existing = nextVars[existingIdx]!;
      nextVars[existingIdx] = {
        ...existing,
        enabled: true,
        currentValue: nextValue,
      };
    } else {
      const isSecret = SECRET_KEY_PATTERN.test(rule.varName);
      const newVar: EnvVariable = {
        id: nextRuleVarId(),
        enabled: true,
        key: rule.varName,
        type: isSecret ? 'secret' : 'default',
        initialValue: '',
        currentValue: nextValue,
      };
      nextVars = [...nextVars, newVar];
    }

    applied.push({
      varName: rule.varName,
      path: rule.sourcePath,
      hasBearerPrefix: /^bearer\s+/i.test(nextValue),
    });
  }

  if (applied.length === 0) {
    return { updatedEnv: env, applied: [] };
  }

  return {
    updatedEnv: {
      ...env,
      variables: nextVars,
    },
    applied,
  };
}

/**
 * Upsert an extracted session token directly into an Environment variable
 * (matching Postman's workflow for `{{token}}` / `{{access_token}}`).
 */
export function upsertTokenIntoEnvironment(
  env: Environment,
  rawToken: string,
  options?: {
    withBearerPrefix?: boolean;
    preferredVarName?: string;
  },
): { updatedEnv: Environment; varName: string; storedValue: string } {
  const candidates = options?.preferredVarName
    ? [options.preferredVarName]
    : ['token', 'access_token', 'jwt', 'auth_token', 'bearer_token'];

  const existingIdx = env.variables.findIndex((v) =>
    candidates.includes(v.key.trim().toLowerCase()),
  );

  const varName = existingIdx >= 0 ? env.variables[existingIdx]!.key.trim() : candidates[0]!;
  const trimmedToken = rawToken.trim();
  const storedValue =
    options?.withBearerPrefix && !/^bearer\s+/i.test(trimmedToken)
      ? `Bearer ${trimmedToken}`
      : trimmedToken;

  if (existingIdx >= 0) {
    return {
      varName,
      storedValue,
      updatedEnv: {
        ...env,
        variables: env.variables.map((v, i) =>
          i === existingIdx ? { ...v, enabled: true, currentValue: storedValue } : v,
        ),
      },
    };
  }

  return {
    varName,
    storedValue,
    updatedEnv: {
      ...env,
      variables: [
        ...env.variables,
        {
          id: nextRuleVarId(),
          enabled: true,
          key: varName,
          type: 'secret',
          initialValue: '',
          currentValue: storedValue,
        },
      ],
    },
  };
}

/**
 * Layer Collection Variables beneath Active Environment (Postman variable scope semantics).
 * Active Environment overrides Collection Variables when keys overlap.
 */
export function mergeCollectionAndActiveEnv(
  activeEnv: Environment | null,
  collectionEnv: Environment | null,
): {
  effectiveEnv: Environment | null;
  sources: Record<string, 'environment' | 'collection'>;
} {
  const sources: Record<string, 'environment' | 'collection'> = {};
  if (!activeEnv && !collectionEnv) {
    return { effectiveEnv: null, sources };
  }
  if (!collectionEnv || (activeEnv && activeEnv.id === collectionEnv.id)) {
    if (activeEnv) {
      for (const v of activeEnv.variables) {
        if (v.enabled && v.key.trim()) sources[v.key.trim()] = 'environment';
      }
    }
    return { effectiveEnv: activeEnv, sources };
  }
  if (!activeEnv) {
    for (const v of collectionEnv.variables) {
      if (v.enabled && v.key.trim()) sources[v.key.trim()] = 'collection';
    }
    return { effectiveEnv: collectionEnv, sources };
  }

  const mergedMap = new Map<string, EnvVariable>();
  for (const v of collectionEnv.variables) {
    const key = v.key.trim();
    if (!v.enabled || !key) continue;
    mergedMap.set(key, v);
    sources[key] = 'collection';
  }
  for (const v of activeEnv.variables) {
    const key = v.key.trim();
    if (!v.enabled || !key) continue;
    mergedMap.set(key, v);
    sources[key] = 'environment';
  }

  return {
    effectiveEnv: {
      id: activeEnv.id,
      name: activeEnv.name,
      variables: Array.from(mergedMap.values()),
    },
    sources,
  };
}

export interface BearerHeaderIssue {
  headerId: string;
  currentTemplate: string;
  suggestedTemplate: string;
  envVarName: string | null;
}

/**
 * Detect when an enabled `Authorization` header resolves to a bare JWT without a `Bearer ` scheme prefix,
 * which causes JWT middleware (e.g., Laravel `tymon/jwt-auth`) to reject with "Authorization Token not found".
 */
export function detectBareJwtAuthorizationHeader(
  headers: KeyValueRow[],
  activeEnv: Environment | null,
  lastResponseBody: unknown,
  manualPassthroughToken?: { path: string; value: string } | null,
  allowResponseFallback = true,
): BearerHeaderIssue | null {
  let targetRow: KeyValueRow | null = null;
  for (const row of headers) {
    if (!row.enabled) continue;
    if (row.key.trim().toLowerCase() === 'authorization') {
      targetRow = row;
    }
  }
  if (!targetRow) return null;

  const trimmedVal = targetRow.value.trim();
  if (!trimmedVal || /^(bearer|basic|token|digest)\s+/i.test(trimmedVal)) {
    return null;
  }

  const sub = substituteTemplate(
    trimmedVal,
    activeEnv,
    lastResponseBody,
    manualPassthroughToken,
    { allowResponseFallback },
  );
  if (sub.unresolved.length > 0) return null;

  const resolvedTrimmed = sub.resolved.trim();
  if (!JWT_SHAPE_REGEX.test(resolvedTrimmed)) {
    return null;
  }

  const singleEnvMatch = trimmedVal.match(/^\{\{\s*([^.{}\s]+)\s*\}\}$/);
  return {
    headerId: targetRow.id,
    currentTemplate: trimmedVal,
    suggestedTemplate: `Bearer ${trimmedVal}`,
    envVarName: singleEnvMatch ? singleEnvMatch[1] : null,
  };
}
