import {
  ALLOWED_METHODS,
  type CollectionGroup,
  type CollectionRequestItem,
  type Environment,
  type EnvVariable,
  type HttpMethod,
  type KeyValueRow,
} from '../types/api';
import { extractPlaceholderNames, validateJsonTemplateSyntax } from './variables';
import { extractPostResponseVarRulesFromPostmanEvents } from './postResponseScripts';

export const MAX_IMPORT_MB = 20;
export const MAX_IMPORT_BYTES = MAX_IMPORT_MB * 1024 * 1024; // 20 MB client-side import limit
const MAX_FOLDER_DEPTH = 32;
const MAX_COLLECTION_ITEMS = 2000;

const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[_-]?key|auth|bearer|private)/i;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let idCounter = 1;
export function nextUid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export type CollectionParseResult =
  | {
      ok: true;
      collection: CollectionGroup;
      skippedCount: number;
      collectionEnv?: Environment;
    }
  | { ok: false; error: string };

export type EnvironmentParseResult =
  | { ok: true; environment: Environment; secretFlaggedCount: number }
  | { ok: false; error: string };

export type AutoPostmanParseResult =
  | {
      ok: true;
      kind: 'collection';
      collection: CollectionGroup;
      skippedCount: number;
      collectionEnv?: Environment;
    }
  | { ok: true; kind: 'environment'; environment: Environment; secretFlaggedCount: number }
  | { ok: false; error: string };

interface PostmanRawAuth {
  type?: string;
  bearer?: Array<{ key?: string; value?: string }>;
}

interface PostmanRawUrlObject {
  raw?: string;
  protocol?: string;
  host?: string | string[];
  port?: string;
  path?: string | string[];
  query?: Array<{ key?: string; value?: string; disabled?: boolean; description?: string }>;
  variable?: Array<{ key?: string; value?: string; description?: string }>;
}

interface PostmanRawItem {
  name?: string;
  item?: PostmanRawItem[];
  auth?: PostmanRawAuth;
  request?: {
    method?: string;
    header?: Array<{ key?: string; value?: string; disabled?: boolean; description?: string }>;
    url?: string | PostmanRawUrlObject;
    body?: {
      mode?: string;
      raw?: string;
      urlencoded?: Array<{ key?: string; value?: string; disabled?: boolean; type?: string }>;
      formdata?: Array<{ key?: string; value?: string; disabled?: boolean; type?: string }>;
      options?: { raw?: { language?: string } };
    };
    auth?: PostmanRawAuth;
  };
  event?: unknown[];
}

function normalizeMethod(rawMethod?: string): { method: HttpMethod; warning?: string } {
  const upper = String(rawMethod ?? 'GET').toUpperCase();
  if (ALLOWED_METHODS.includes(upper as HttpMethod)) {
    return { method: upper as HttpMethod };
  }
  return {
    method: 'GET',
    warning: `Method "${upper}" tidak didukung backend; diubah menjadi GET.`,
  };
}

function reconstructStructuredUrl(urlObj: PostmanRawUrlObject): string {
  const hostStr = Array.isArray(urlObj.host)
    ? urlObj.host.filter(Boolean).join('.')
    : String(urlObj.host ?? '').trim();

  const pathStr = Array.isArray(urlObj.path)
    ? urlObj.path.filter(Boolean).join('/')
    : String(urlObj.path ?? '').replace(/^\/+/, '');

  if (!hostStr && !pathStr) return '';

  const startsWithVarOrScheme = /^(\{\{[^}]+\}\}|https?:\/\/)/i.test(hostStr);
  const prefix = startsWithVarOrScheme
    ? hostStr
    : `${urlObj.protocol ? `${urlObj.protocol}://` : 'https://'}${hostStr}`;

  const withPort = urlObj.port && !prefix.includes(`:${urlObj.port}`) ? `${prefix}:${urlObj.port}` : prefix;
  if (!pathStr) return withPort;
  return `${withPort.replace(/\/+$/, '')}/${pathStr.replace(/^\/+/, '')}`;
}

function parsePostmanUrl(
  rawUrl: NonNullable<PostmanRawItem['request']>['url'],
): { baseUrl: string; queryParams: KeyValueRow[]; urlWarnings: string[] } {
  if (!rawUrl) return { baseUrl: '', queryParams: [], urlWarnings: [] };

  const queryParams: KeyValueRow[] = [];
  const urlWarnings: string[] = [];

  let fullRaw =
    typeof rawUrl === 'string'
      ? rawUrl.trim()
      : String(rawUrl.raw ?? '').trim() || reconstructStructuredUrl(rawUrl);

  // Replace Postman :pathVar syntax in a single linear pass (escaped keys, bounded length)
  if (typeof rawUrl === 'object' && Array.isArray(rawUrl.variable) && rawUrl.variable.length > 0) {
    const missingPathVars: string[] = [];
    const replacements = new Map<string, string>();
    for (const pv of rawUrl.variable) {
      const k = String(pv.key ?? '').trim();
      if (!k) continue;
      const val = String(pv.value ?? '').trim();
      if (val) {
        replacements.set(k, val);
      } else {
        missingPathVars.push(`:${k}`);
      }
    }
    if (replacements.size > 0) {
      const alternation = Array.from(replacements.keys())
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
      const pathVarRegex = new RegExp(`:(${alternation})(?=/|\\?|$)`, 'g');
      const replaced = fullRaw.replace(pathVarRegex, (match, key: string) => replacements.get(key) ?? match);
      if (replaced.length <= 8192) {
        fullRaw = replaced;
      } else {
        urlWarnings.push('URL melebihi batas panjang setelah substitusi path parameter.');
      }
    }
    if (missingPathVars.length > 0) {
      urlWarnings.push(`Path parameter belum terisi: ${missingPathVars.join(', ')}.`);
    }
  }

  if (typeof rawUrl === 'object' && Array.isArray(rawUrl.query) && rawUrl.query.length > 0) {
    const seen = new Map<string, number>();
    for (const q of rawUrl.query) {
      const key = String(q.key ?? '').trim();
      if (!key) continue;
      const row: KeyValueRow = {
        id: nextUid('qp'),
        enabled: !q.disabled,
        key,
        value: String(q.value ?? ''),
        description: String(q.description ?? ''),
      };
      const existing = seen.get(key);
      if (existing !== undefined) {
        queryParams[existing] = row;
      } else {
        seen.set(key, queryParams.length);
        queryParams.push(row);
      }
    }
    const qIdx = fullRaw.indexOf('?');
    if (qIdx >= 0) fullRaw = fullRaw.slice(0, qIdx);
    return { baseUrl: fullRaw, queryParams, urlWarnings };
  }

  // Fallback: split query string from raw URL if present
  const qIdx = fullRaw.indexOf('?');
  if (qIdx >= 0) {
    const basePart = fullRaw.slice(0, qIdx);
    const searchPart = fullRaw.slice(qIdx + 1);
    const params = new URLSearchParams(searchPart);
    const seen = new Map<string, number>();
    params.forEach((value, key) => {
      const row: KeyValueRow = {
        id: nextUid('qp'),
        enabled: true,
        key,
        value,
        description: '',
      };
      const existing = seen.get(key);
      if (existing !== undefined) {
        queryParams[existing] = row;
      } else {
        seen.set(key, queryParams.length);
        queryParams.push(row);
      }
    });
    return { baseUrl: basePart, queryParams, urlWarnings };
  }

  return { baseUrl: fullRaw, queryParams, urlWarnings };
}

function parseCollectionVariables(
  collectionName: string,
  rawVars: unknown,
): Environment | undefined {
  if (!Array.isArray(rawVars)) return undefined;
  const variables: EnvVariable[] = [];
  for (const entry of rawVars) {
    if (!entry || typeof entry !== 'object') continue;
    const v = entry as { key?: string; value?: string; disabled?: boolean; type?: string };
    const key = String(v.key ?? '').trim();
    if (!key) continue;
    const isSecret = v.type === 'secret' || SECRET_KEY_PATTERN.test(key);
    const val = String(v.value ?? '');
    variables.push({
      id: nextUid('envv'),
      enabled: !v.disabled,
      key,
      type: isSecret ? 'secret' : 'default',
      initialValue: isSecret ? '' : val,
      currentValue: val,
    });
  }
  if (variables.length === 0) return undefined;
  return {
    id: nextUid('env'),
    name: `${collectionName} (Vars)`,
    variables,
  };
}

function parsePostmanCollectionObject(json: unknown): CollectionParseResult {
  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: 'Format file tidak dikenali.' };
  }

  const doc = json as {
    info?: { name?: string; schema?: string };
    item?: PostmanRawItem[];
    auth?: PostmanRawAuth;
    variable?: unknown;
  };
  const schema = String(doc.info?.schema ?? '');
  if (!schema.includes('schema.getpostman.com/json/collection/v2.')) {
    return {
      ok: false,
      error: 'Format file tidak dikenali. Gunakan Postman Collection v2.0 atau v2.1 (info.schema tidak cocok).',
    };
  }

  if (!Array.isArray(doc.item)) {
    return { ok: false, error: 'Collection tidak memiliki daftar item request.' };
  }

  const collectionName = String(doc.info?.name ?? 'Imported Collection');
  const collectionEnv = parseCollectionVariables(collectionName, doc.variable);

  const items: CollectionRequestItem[] = [];
  let skippedCount = 0;
  let depthExceeded = false;
  let itemLimitReached = false;

  const walk = (nodes: PostmanRawItem[], folderPath: string[], inheritedAuth?: PostmanRawAuth, depth = 0) => {
    if (depth > MAX_FOLDER_DEPTH) {
      depthExceeded = true;
      return;
    }
    for (const node of nodes) {
      if (items.length >= MAX_COLLECTION_ITEMS) {
        itemLimitReached = true;
        return;
      }
      if (!node || typeof node !== 'object') continue;
      const effectiveFolderAuth = node.auth ?? inheritedAuth;
      if (Array.isArray(node.item)) {
        walk(node.item, [...folderPath, String(node.name ?? 'Folder')], effectiveFolderAuth, depth + 1);
        continue;
      }
      if (!node.request) {
        skippedCount += 1;
        continue;
      }

      const warnings: string[] = [];
      const req = node.request;
      const { method, warning: methodWarn } = normalizeMethod(req.method);
      if (methodWarn) warnings.push(methodWarn);

      const { baseUrl, queryParams, urlWarnings } = parsePostmanUrl(req.url);
      warnings.push(...urlWarnings);

      // Headers with duplicate-key guard
      const headers: KeyValueRow[] = [];
      const seenHeaderIndex = new Map<string, number>();
      let hasDupHeader = false;
      for (const h of req.header ?? []) {
        const key = String(h.key ?? '').trim();
        if (!key) continue;
        const lower = key.toLowerCase();
        const row: KeyValueRow = {
          id: nextUid('hdr'),
          enabled: !h.disabled,
          key,
          value: String(h.value ?? ''),
          description: String(h.description ?? ''),
        };
        const existingIdx = seenHeaderIndex.get(lower);
        if (existingIdx !== undefined) {
          hasDupHeader = true;
          headers[existingIdx] = row;
        } else {
          seenHeaderIndex.set(lower, headers.length);
          headers.push(row);
        }
      }
      if (hasDupHeader) {
        warnings.push('Header duplikat terdeteksi: nilai terakhir digunakan.');
      }

      // Auth mapping (supports request auth or inherited folder/collection auth)
      const effectiveAuth = req.auth ?? inheritedAuth;
      if (effectiveAuth && effectiveAuth.type && effectiveAuth.type !== 'noauth') {
        if (effectiveAuth.type === 'bearer') {
          const tokenObj = (effectiveAuth.bearer ?? []).find((b) => b.key === 'token');
          const tokenVal = tokenObj?.value ? String(tokenObj.value) : '{{$.data.token}}';
          if (!seenHeaderIndex.has('authorization')) {
            headers.push({
              id: nextUid('hdr'),
              enabled: true,
              key: 'Authorization',
              value: `Bearer ${tokenVal}`,
              description: req.auth ? 'Imported Bearer auth' : 'Inherited Bearer auth',
            });
            seenHeaderIndex.set('authorization', headers.length - 1);
            if (!req.auth && /^https?:\/\//i.test(baseUrl.trim())) {
              warnings.push('Bearer auth diwarisi ke URL eksplisit: pastikan domain target tepercaya.');
            }
          }
        } else if (req.auth) {
          warnings.push(`Auth bertipe "${effectiveAuth.type}" tidak dikonversi otomatis (hanya Bearer yang didukung).`);
        }
      }

      // Body mapping (raw JSON, urlencoded, formdata text fields)
      let bodyText = '';
      if (req.body && req.body.mode) {
        if (req.body.mode === 'raw' && typeof req.body.raw === 'string' && req.body.raw.trim() !== '') {
          try {
            const parsed = JSON.parse(req.body.raw);
            bodyText = JSON.stringify(parsed, null, 2);
          } catch {
            bodyText = req.body.raw;
            if (!validateJsonTemplateSyntax(req.body.raw).ok) {
              warnings.push('Body raw bukan JSON valid: periksa atau perbaiki sebelum Execute.');
            }
          }
        } else if (req.body.mode === 'urlencoded' && Array.isArray(req.body.urlencoded)) {
          const obj: Record<string, string> = {};
          for (const entry of req.body.urlencoded) {
            if (entry.disabled || !entry.key?.trim()) continue;
            obj[entry.key.trim()] = String(entry.value ?? '');
          }
          if (Object.keys(obj).length > 0) {
            bodyText = JSON.stringify(obj, null, 2);
            warnings.push('Body mode urlencoded dikonversi ke JSON object. Periksa format yang diharapkan server.');
          }
        } else if (req.body.mode === 'formdata' && Array.isArray(req.body.formdata)) {
          const obj: Record<string, string> = {};
          let skippedFiles = 0;
          for (const entry of req.body.formdata) {
            if (entry.disabled || !entry.key?.trim()) continue;
            if (entry.type === 'file') {
              skippedFiles += 1;
              continue;
            }
            obj[entry.key.trim()] = String(entry.value ?? '');
          }
          if (Object.keys(obj).length > 0) {
            bodyText = JSON.stringify(obj, null, 2);
          }
          warnings.push(
            skippedFiles > 0
              ? `Body mode formdata dikonversi ke JSON object (${skippedFiles} field file dilewati).`
              : 'Body mode formdata dikonversi ke JSON object. Periksa format yang diharapkan server.',
          );
        } else if (req.body.mode !== 'raw' && req.body.mode !== 'none') {
          warnings.push(`Mode body "${req.body.mode}" tidak didukung (hanya JSON raw).`);
        }
      }

      // Extract safe declarative Environment variable setters from Postman test scripts (zero eval)
      const scriptExtraction = extractPostResponseVarRulesFromPostmanEvents(node.event);
      if (scriptExtraction.rules.length > 0) {
        const names = scriptExtraction.rules.map((r) => `{{${r.varName}}}`).join(', ');
        warnings.push(
          `Auto-sync variabel (${names}) diimport dari script Postman dan dijalankan otomatis setelah status 2xx.`,
        );
      }
      if (scriptExtraction.hasUnhandledScripts) {
        warnings.push(
          scriptExtraction.rules.length > 0
            ? 'Bagian script Postman lainnya (assertion/logika kustom) diabaikan. Atur assertion manual di tab Assertions.'
            : 'Script pre-request/test Postman diabaikan. Atur assertion manual di tab Assertions.',
        );
      }

      // Detect {{variables}} across URL, params, headers, body
      const placeholders = new Set<string>([
        ...extractPlaceholderNames(baseUrl),
        ...queryParams.flatMap((q) => extractPlaceholderNames(q.value)),
        ...headers.flatMap((h) => extractPlaceholderNames(h.value)),
        ...extractPlaceholderNames(bodyText),
      ]);
      if (placeholders.size > 0) {
        warnings.push(
          `Variabel terdeteksi: ${Array.from(placeholders)
            .map((p) => `{{${p}}}`)
            .join(', ')}. Pastikan Environment aktif sudah mendefinisikannya.`,
        );
      }

      items.push({
        id: nextUid('req'),
        name: String(node.name ?? 'Untitled Request'),
        folderPath,
        method,
        url: baseUrl,
        headers,
        queryParams,
        bodyText,
        warnings,
        ...(scriptExtraction.rules.length > 0
          ? { postResponseVars: scriptExtraction.rules }
          : {}),
      });
    }
  };

  walk(doc.item, [], doc.auth, 0);

  if (depthExceeded) {
    return { ok: false, error: `Struktur folder Postman melebihi batas kedalaman maksimal (${MAX_FOLDER_DEPTH}).` };
  }

  if (items.length === 0) {
    return { ok: false, error: 'Tidak ada request valid yang ditemukan dalam file collection ini.' };
  }

  if (itemLimitReached) {
    items[0]!.warnings.push(`Koleksi dipotong pada ${MAX_COLLECTION_ITEMS} request maksimal.`);
  }

  return {
    ok: true,
    collection: {
      id: nextUid('col'),
      name: collectionName,
      items,
    },
    skippedCount,
    ...(collectionEnv ? { collectionEnv } : {}),
  };
}

export function parsePostmanCollectionJson(rawText: string): CollectionParseResult {
  const byteSize = new TextEncoder().encode(rawText).byteLength;
  if (byteSize > MAX_IMPORT_BYTES) {
    return { ok: false, error: `Ukuran file melebihi batas maksimal ${MAX_IMPORT_MB} MB.` };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'File bukan JSON yang valid atau rusak.' };
  }

  return parsePostmanCollectionObject(json);
}

function parsePostmanEnvironmentObject(json: unknown): EnvironmentParseResult {
  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: 'Format file Environment tidak dikenali.' };
  }

  const doc = json as {
    name?: string;
    values?: Array<{ key?: string; value?: string; enabled?: boolean; type?: string }>;
  };

  if (!Array.isArray(doc.values)) {
    return {
      ok: false,
      error: 'Format Environment JSON tidak valid: properti "values" (array) tidak ditemukan.',
    };
  }

  let secretFlaggedCount = 0;
  const variables: EnvVariable[] = doc.values
    .filter((v) => v && typeof v.key === 'string' && v.key.trim() !== '')
    .map((v) => {
      const key = String(v.key).trim();
      const isSecret = v.type === 'secret' || SECRET_KEY_PATTERN.test(key);
      if (isSecret) secretFlaggedCount += 1;
      const val = String(v.value ?? '');
      return {
        id: nextUid('envv'),
        enabled: v.enabled !== false,
        key,
        type: isSecret ? 'secret' : 'default',
        initialValue: isSecret ? '' : val,
        currentValue: val,
      };
    });

  return {
    ok: true,
    environment: {
      id: nextUid('env'),
      name: String(doc.name ?? 'Imported Environment'),
      variables,
    },
    secretFlaggedCount,
  };
}

export function parsePostmanEnvironmentJson(rawText: string): EnvironmentParseResult {
  const byteSize = new TextEncoder().encode(rawText).byteLength;
  if (byteSize > MAX_IMPORT_BYTES) {
    return { ok: false, error: `Ukuran file melebihi batas maksimal ${MAX_IMPORT_MB} MB.` };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'File Environment bukan JSON yang valid.' };
  }

  return parsePostmanEnvironmentObject(json);
}

export function parsePostmanAutoJson(rawText: string): AutoPostmanParseResult {
  const byteSize = new TextEncoder().encode(rawText).byteLength;
  if (byteSize > MAX_IMPORT_BYTES) {
    return { ok: false, error: `Ukuran file melebihi batas maksimal ${MAX_IMPORT_MB} MB.` };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'File bukan JSON yang valid atau rusak.' };
  }

  if (typeof json !== 'object' || json === null) {
    return { ok: false, error: 'Format file tidak dikenali.' };
  }

  const doc = json as {
    info?: { schema?: string };
    values?: unknown;
  };

  if (typeof doc.info?.schema === 'string' && doc.info.schema.includes('schema.getpostman.com/json/collection/v2.')) {
    const res = parsePostmanCollectionObject(json);
    if (!res.ok) return res;
    return {
      ok: true,
      kind: 'collection',
      collection: res.collection,
      skippedCount: res.skippedCount,
      ...(res.collectionEnv ? { collectionEnv: res.collectionEnv } : {}),
    };
  }

  if (Array.isArray(doc.values)) {
    const res = parsePostmanEnvironmentObject(json);
    if (!res.ok) return res;
    return {
      ok: true,
      kind: 'environment',
      environment: res.environment,
      secretFlaggedCount: res.secretFlaggedCount,
    };
  }

  return {
    ok: false,
    error: 'Format file tidak dikenali. Gunakan file JSON Postman Collection v2.0/v2.1 atau Postman Environment.',
  };
}

/**
 * Exports an Environment as Postman Environment JSON.
 * Secret values are intentionally stripped (blank) to prevent credential leakage.
 */
export function exportEnvironmentAsPostmanJson(env: Environment): string {
  const payload = {
    id: env.id,
    name: env.name,
    _postman_variable_scope: 'environment',
    values: env.variables
      .filter((v) => v.key.trim() !== '')
      .map((v) => ({
        key: v.key.trim(),
        value: v.type === 'secret' ? '' : v.initialValue,
        type: v.type,
        enabled: v.enabled,
      })),
  };
  return JSON.stringify(payload, null, 2);
}
