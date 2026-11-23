import {
  ALLOWED_METHODS,
  type CollectionGroup,
  type CollectionRequestItem,
  type Environment,
  type EnvVariable,
  type HttpMethod,
  type KeyValueRow,
} from '../types/api';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_MB,
  nextUid,
  parsePostmanAutoJson,
} from './postmanImport';
import { extractPlaceholderNames, validateJsonTemplateSyntax } from './variables';
import { extractPostResponseVarRulesFromScript } from './postResponseScripts';

const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[_-]?key|auth|bearer|private)/i;
const BRU_HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
const MAX_FOLDER_DEPTH = 32;
const MAX_COLLECTION_ITEMS = 2000;
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
]);

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface InheritedBrunoContext {
  authHeader?: { key: string; value: string };
  authQuery?: { key: string; value: string };
  headers?: Array<{ key: string; value: string; enabled: boolean }>;
}

export type BrunoCollectionParseResult =
  | {
      ok: true;
      collection: CollectionGroup;
      environments: Environment[];
      skippedCount: number;
    }
  | { ok: false; error: string };

export type BrunoEnvironmentParseResult =
  | {
      ok: true;
      environment: Environment;
      secretFlaggedCount: number;
    }
  | { ok: false; error: string };

export type BruRequestParseResult =
  | { ok: true; item: CollectionRequestItem }
  | { ok: false; error: string };

export type BrunoFilesAssembleResult =
  | {
      ok: true;
      collection: CollectionGroup | null;
      environments: Environment[];
      warnings: string[];
    }
  | { ok: false; error: string };

export type AutoImportFileResult =
  | {
      ok: true;
      kind: 'collection';
      source: 'postman' | 'bruno-json' | 'bruno-bru';
      collection: CollectionGroup;
      environments: Environment[];
      skippedCount: number;
    }
  | {
      ok: true;
      kind: 'environment';
      source: 'postman' | 'bruno-json' | 'bruno-bru';
      environment: Environment;
      secretFlaggedCount: number;
    }
  | { ok: false; error: string };

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

function encodeBasicAuth(username: string, password: string): string {
  const raw = `${username}:${password}`;
  try {
    const bytes = new TextEncoder().encode(raw);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `Basic ${btoa(binary)}`;
  } catch {
    return `Basic ${raw}`;
  }
}

function stripQueryFromUrl(rawUrl: string): {
  baseUrl: string;
  inlineQuery: Array<{ key: string; value: string }>;
} {
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return { baseUrl: rawUrl, inlineQuery: [] };
  const baseUrl = rawUrl.slice(0, qIndex);
  const queryPart = rawUrl.slice(qIndex + 1).split('#')[0];
  const inlineQuery: Array<{ key: string; value: string }> = [];
  for (const pair of queryPart.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) {
      inlineQuery.push({ key: decodeSafe(pair), value: '' });
    } else {
      inlineQuery.push({
        key: decodeSafe(pair.slice(0, eq)),
        value: decodeSafe(pair.slice(eq + 1)),
      });
    }
  }
  return { baseUrl, inlineQuery };
}

function decodeSafe(str: string): string {
  try {
    return decodeURIComponent(str.replace(/\+/g, ' '));
  } catch {
    return str;
  }
}

function dedupeHeadersCaseInsensitive(
  rows: KeyValueRow[],
  warnings: string[],
): KeyValueRow[] {
  const seen = new Map<string, number>();
  const out: KeyValueRow[] = [];
  for (const row of rows) {
    if (!row.enabled) {
      out.push(row);
      continue;
    }
    const lower = row.key.toLowerCase();
    const prevIdx = seen.get(lower);
    if (prevIdx !== undefined) {
      out[prevIdx] = row;
      warnings.push(`Header duplikat "${row.key}" terdeteksi; nilai terakhir dipertahankan.`);
    } else {
      seen.set(lower, out.length);
      out.push(row);
    }
  }
  return out;
}

function dedupeQueryRows(rows: KeyValueRow[], warnings: string[]): KeyValueRow[] {
  const seen = new Map<string, number>();
  const out: KeyValueRow[] = [];
  for (const row of rows) {
    if (!row.enabled) {
      out.push(row);
      continue;
    }
    const prevIdx = seen.get(row.key);
    if (prevIdx !== undefined) {
      out[prevIdx] = row;
      warnings.push(`Query param duplikat "${row.key}" terdeteksi; nilai terakhir dipertahankan.`);
    } else {
      seen.set(row.key, out.length);
      out.push(row);
    }
  }
  return out;
}

function applyPathParamsToUrl(
  url: string,
  pathParams: Array<{ key: string; value: string }>,
  warnings: string[],
): string {
  let out = url;
  const unresolved: string[] = [];
  const replacements = new Map<string, string>();
  for (const p of pathParams) {
    const k = p.key.trim();
    if (!k || !out.includes(`:${k}`)) continue;
    const trimmed = p.value.trim();
    if (trimmed !== '') {
      replacements.set(k, trimmed);
    } else {
      unresolved.push(`:${k}`);
    }
  }
  if (replacements.size > 0) {
    const alternation = Array.from(replacements.keys())
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
    const rx = new RegExp(`:(${alternation})(?=/|\\?|$)`, 'g');
    const replaced = out.replace(rx, (match, key: string) => replacements.get(key) ?? match);
    if (replaced.length <= 8192) {
      out = replaced;
    } else {
      warnings.push('URL melebihi batas panjang setelah substitusi path variable.');
    }
  }
  if (unresolved.length > 0) {
    warnings.push(`Path variable belum bernilai: ${unresolved.join(', ')}.`);
  }
  return out;
}

function addUnresolvedPlaceholderWarning(
  url: string,
  headers: KeyValueRow[],
  queryParams: KeyValueRow[],
  bodyText: string,
  warnings: string[],
) {
  const allRefs = new Set<string>();
  for (const n of extractPlaceholderNames(url)) allRefs.add(n);
  for (const h of headers) {
    for (const n of extractPlaceholderNames(h.key)) allRefs.add(n);
    for (const n of extractPlaceholderNames(h.value)) allRefs.add(n);
  }
  for (const q of queryParams) {
    for (const n of extractPlaceholderNames(q.key)) allRefs.add(n);
    for (const n of extractPlaceholderNames(q.value)) allRefs.add(n);
  }
  for (const n of extractPlaceholderNames(bodyText)) allRefs.add(n);

  if (allRefs.size > 0) {
    const list = Array.from(allRefs)
      .map((n) => `{{${n}}}`)
      .join(', ');
    warnings.push(`Request ini memakai variabel: ${list}. Pastikan Environment aktif menyediakannya.`);
  }
}

/* ============================================================================
 * PART 1: Bruno Collection JSON & Bruno Environment JSON
 * ========================================================================== */

interface BrunoJsonAuth {
  mode?: string;
  bearer?: { token?: string };
  basic?: { username?: string; password?: string };
  apikey?: { key?: string; value?: string; placement?: string };
}

interface BrunoJsonHeader {
  name?: string;
  value?: string;
  enabled?: boolean;
}

interface BrunoJsonParam {
  name?: string;
  value?: string;
  type?: string;
  enabled?: boolean;
}

interface BrunoJsonBody {
  mode?: string;
  json?: string;
  text?: string;
  formUrlEncoded?: Array<{ name?: string; value?: string; enabled?: boolean }>;
  multipartForm?: Array<{ name?: string; value?: string; type?: string; enabled?: boolean }>;
}

interface BrunoJsonRequest {
  url?: string;
  method?: string;
  headers?: BrunoJsonHeader[];
  params?: BrunoJsonParam[];
  body?: BrunoJsonBody;
  auth?: BrunoJsonAuth;
  vars?: { req?: Array<{ name?: string; value?: string; enabled?: boolean }> };
  script?: { req?: string; res?: string };
  tests?: string;
  assertions?: Array<{ name?: string; value?: string; enabled?: boolean }>;
}

interface BrunoJsonItem {
  type?: string;
  name?: string;
  items?: BrunoJsonItem[];
  root?: { request?: BrunoJsonRequest };
  request?: BrunoJsonRequest;
}

interface BrunoJsonEnvironment {
  name?: string;
  variables?: Array<{ name?: string; value?: string; enabled?: boolean; secret?: boolean }>;
}

interface BrunoJsonDocument {
  name?: string;
  version?: string;
  items?: BrunoJsonItem[];
  root?: { request?: BrunoJsonRequest };
  environments?: BrunoJsonEnvironment[];
}

function extractBrunoJsonAuth(
  auth: BrunoJsonAuth | undefined,
  inherited?: InheritedBrunoContext,
): { header?: { key: string; value: string }; query?: { key: string; value: string } } {
  if (!auth || !auth.mode || auth.mode === 'inherit') {
    return {
      header: inherited?.authHeader,
      query: inherited?.authQuery,
    };
  }
  if (auth.mode === 'none') {
    return {};
  }
  if (auth.mode === 'bearer' && auth.bearer?.token) {
    return { header: { key: 'Authorization', value: `Bearer ${auth.bearer.token}` } };
  }
  if (auth.mode === 'basic' && (auth.basic?.username || auth.basic?.password)) {
    return {
      header: {
        key: 'Authorization',
        value: encodeBasicAuth(auth.basic?.username ?? '', auth.basic?.password ?? ''),
      },
    };
  }
  if (auth.mode === 'apikey' && auth.apikey?.key) {
    if (auth.apikey.placement === 'queryparams' || auth.apikey.placement === 'query') {
      return { query: { key: auth.apikey.key, value: auth.apikey.value ?? '' } };
    }
    return { header: { key: auth.apikey.key, value: auth.apikey.value ?? '' } };
  }
  return {};
}

function mergeInheritedBrunoContext(
  parent: InheritedBrunoContext | undefined,
  rootReq: BrunoJsonRequest | undefined,
): InheritedBrunoContext {
  if (!rootReq) return parent ?? {};
  const resolvedAuth = extractBrunoJsonAuth(rootReq.auth, parent);
  const nextHeaders: Array<{ key: string; value: string; enabled: boolean }> = [
    ...(parent?.headers ?? []),
  ];
  if (Array.isArray(rootReq.headers)) {
    for (const h of rootReq.headers) {
      if (!h.name) continue;
      nextHeaders.push({
        key: h.name.trim(),
        value: String(h.value ?? ''),
        enabled: h.enabled !== false,
      });
    }
  }
  return {
    authHeader: resolvedAuth.header,
    authQuery: resolvedAuth.query,
    headers: nextHeaders,
  };
}

function parseBrunoEnvironmentObj(doc: BrunoJsonEnvironment): BrunoEnvironmentParseResult {
  if (!Array.isArray(doc.variables)) {
    return { ok: false, error: 'Format Environment Bruno tidak valid: properti "variables" tidak ditemukan.' };
  }

  let secretFlaggedCount = 0;
  const variables: EnvVariable[] = doc.variables
    .filter((v) => v && typeof v.name === 'string' && v.name.trim() !== '')
    .map((v) => {
      const key = String(v.name).trim();
      const isSecret = v.secret === true || SECRET_KEY_PATTERN.test(key);
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
      name: String(doc.name ?? 'Bruno Environment'),
      variables,
    },
    secretFlaggedCount,
  };
}

export function isBrunoCollectionObject(json: unknown): json is BrunoJsonDocument {
  if (typeof json !== 'object' || json === null) return false;
  const doc = json as Record<string, unknown>;
  if (!Array.isArray(doc.items)) return false;
  // Distinguish from Postman (which uses `item`, not `items`)
  if ('info' in doc && typeof doc.info === 'object' && doc.info !== null && 'schema' in (doc.info as Record<string, unknown>)) {
    return false;
  }
  return typeof doc.name === 'string' || typeof doc.version === 'string';
}

export function isBrunoEnvironmentObject(json: unknown): json is BrunoJsonEnvironment {
  if (typeof json !== 'object' || json === null) return false;
  const doc = json as Record<string, unknown>;
  if (!Array.isArray(doc.variables)) return false;
  if (Array.isArray(doc.items)) return false;
  return doc.variables.every(
    (v) => typeof v === 'object' && v !== null && 'name' in (v as Record<string, unknown>),
  );
}

export function parseBrunoCollectionObject(json: unknown): BrunoCollectionParseResult {
  if (!isBrunoCollectionObject(json)) {
    return { ok: false, error: 'Format Bruno Collection JSON tidak dikenali.' };
  }

  const collectionName = String(json.name ?? 'Imported Bruno Collection');
  const collected: CollectionRequestItem[] = [];
  let skippedCount = 0;
  let depthExceeded = false;

  const rootContext = mergeInheritedBrunoContext(undefined, json.root?.request);

  const walk = (items: BrunoJsonItem[], folderPath: string[], inherited: InheritedBrunoContext, depth = 0) => {
    if (depth > MAX_FOLDER_DEPTH) {
      depthExceeded = true;
      return;
    }
    for (const entry of items) {
      if (collected.length >= MAX_COLLECTION_ITEMS) return;
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'folder' || (Array.isArray(entry.items) && !entry.request)) {
        const folderCtx = mergeInheritedBrunoContext(inherited, entry.root?.request);
        const nextFolder = entry.name ? [...folderPath, entry.name] : folderPath;
        walk(entry.items ?? [], nextFolder, folderCtx, depth + 1);
        continue;
      }

      if (!entry.request) {
        skippedCount += 1;
        continue;
      }

      const req = entry.request;
      const warnings: string[] = [];
      const { method, warning: methodWarning } = normalizeMethod(req.method);
      if (methodWarning) warnings.push(methodWarning);

      const rawUrl = String(req.url ?? '');
      const { baseUrl, inlineQuery } = stripQueryFromUrl(rawUrl);

      const pathParams: Array<{ key: string; value: string }> = [];
      const rawQueryRows: KeyValueRow[] = [];

      if (Array.isArray(req.params) && req.params.length > 0) {
        for (const p of req.params) {
          if (!p.name) continue;
          if (p.type === 'path') {
            if (p.enabled !== false) {
              pathParams.push({ key: p.name.trim(), value: String(p.value ?? '') });
            }
          } else {
            rawQueryRows.push({
              id: nextUid('qp'),
              enabled: p.enabled !== false,
              key: p.name.trim(),
              value: String(p.value ?? ''),
              description: '',
            });
          }
        }
      } else {
        for (const iq of inlineQuery) {
          rawQueryRows.push({
            id: nextUid('qp'),
            enabled: true,
            key: iq.key,
            value: iq.value,
            description: '',
          });
        }
      }

      const resolvedAuth = extractBrunoJsonAuth(req.auth, inherited);
      if (resolvedAuth.query) {
        rawQueryRows.push({
          id: nextUid('qp'),
          enabled: true,
          key: resolvedAuth.query.key,
          value: resolvedAuth.query.value,
          description: 'API Key auth (Bruno)',
        });
      }

      const finalUrl = applyPathParamsToUrl(baseUrl, pathParams, warnings);
      const queryParams = dedupeQueryRows(rawQueryRows, warnings);

      const rawHeaderRows: KeyValueRow[] = [];
      const reqAuthNone = req.auth?.mode === 'none';
      for (const ih of inherited.headers ?? []) {
        if (reqAuthNone && CREDENTIAL_HEADER_NAMES.has(ih.key.trim().toLowerCase())) {
          continue;
        }
        rawHeaderRows.push({
          id: nextUid('hd'),
          enabled: ih.enabled,
          key: ih.key,
          value: ih.value,
          description: 'Diwarisi dari Collection/Folder Bruno',
        });
      }
      if (Array.isArray(req.headers)) {
        for (const h of req.headers) {
          if (!h.name) continue;
          rawHeaderRows.push({
            id: nextUid('hd'),
            enabled: h.enabled !== false,
            key: h.name.trim(),
            value: String(h.value ?? ''),
            description: '',
          });
        }
      }
      if (
        resolvedAuth.header &&
        !rawHeaderRows.some(
          (h) => h.enabled && h.key.toLowerCase() === resolvedAuth.header!.key.toLowerCase(),
        )
      ) {
        rawHeaderRows.push({
          id: nextUid('hd'),
          enabled: true,
          key: resolvedAuth.header.key,
          value: resolvedAuth.header.value,
          description: 'Diimport dari Bruno Auth',
        });
        if ((!req.auth?.mode || req.auth.mode === 'inherit') && /^https?:\/\//i.test(finalUrl.trim())) {
          warnings.push('Auth diwarisi dari folder/collection ke URL eksplisit: pastikan domain tepercaya.');
        }
      }

      const headers = dedupeHeadersCaseInsensitive(rawHeaderRows, warnings);

      let bodyText = '';
      if (method !== 'GET' && req.body && req.body.mode && req.body.mode !== 'none') {
        if (req.body.mode === 'json') {
          bodyText = String(req.body.json ?? '');
          if (bodyText.trim() && !validateJsonTemplateSyntax(bodyText).ok) {
            warnings.push('Body JSON dari Bruno tidak valid atau butuh penyesuaian sebelum Execute.');
          }
        } else if (req.body.mode === 'text') {
          bodyText = String(req.body.text ?? '');
          if (bodyText.trim() && !validateJsonTemplateSyntax(bodyText).ok) {
            warnings.push('Body bertipe text dari Bruno bukan JSON valid (backend ACF hanya menerima JSON).');
          }
        } else if (req.body.mode === 'formUrlEncoded' && Array.isArray(req.body.formUrlEncoded)) {
          const obj: Record<string, string> = {};
          for (const f of req.body.formUrlEncoded) {
            if (f.enabled === false || !f.name) continue;
            obj[f.name] = String(f.value ?? '');
          }
          bodyText = JSON.stringify(obj, null, 2);
          warnings.push('Body form-urlencoded dari Bruno dikonversi ke JSON.');
        } else if (req.body.mode === 'multipartForm' && Array.isArray(req.body.multipartForm)) {
          const obj: Record<string, string> = {};
          let skippedFiles = 0;
          for (const f of req.body.multipartForm) {
            if (f.enabled === false || !f.name) continue;
            if (f.type === 'file') {
              skippedFiles += 1;
              continue;
            }
            obj[f.name] = String(f.value ?? '');
          }
          bodyText = JSON.stringify(obj, null, 2);
          warnings.push(
            skippedFiles > 0
              ? `Body multipart-form dari Bruno dikonversi ke JSON (${skippedFiles} field file dilewati).`
              : 'Body multipart-form dari Bruno dikonversi ke JSON.',
          );
        } else {
          warnings.push(`Body mode "${req.body.mode}" tidak didukung penuh oleh backend JSON.`);
        }
      }

      const brunoResScript = [req.script?.res ?? '', req.tests ?? ''].filter(Boolean).join('\n');
      const brunoRules = extractPostResponseVarRulesFromScript(brunoResScript);
      if (brunoRules.rules.length > 0) {
        const names = brunoRules.rules.map((r) => `{{${r.varName}}}`).join(', ');
        warnings.push(`Auto-sync variabel (${names}) diimport dari script Bruno.`);
      }
      if (req.script?.req?.trim() || brunoRules.hasUnhandledScripts) {
        warnings.push('Script/Tests Bruno lainnya diabaikan; atur validasi di tab Assertions.');
      }
      if (Array.isArray(req.assertions) && req.assertions.length > 0) {
        warnings.push('Blok Assert Bruno tidak diimport otomatis; atur manual di tab Assertions.');
      }

      addUnresolvedPlaceholderWarning(finalUrl, headers, queryParams, bodyText, warnings);

      collected.push({
        id: nextUid('breq'),
        name: entry.name ?? `${method} ${finalUrl || 'Untitled'}`,
        folderPath,
        method,
        url: finalUrl,
        queryParams,
        headers,
        bodyText,
        warnings,
        ...(brunoRules.rules.length > 0 ? { postResponseVars: brunoRules.rules } : {}),
      });
    }
  };

  walk(json.items ?? [], [], rootContext, 0);

  if (depthExceeded) {
    return {
      ok: false,
      error: `Struktur folder Bruno melebihi batas kedalaman maksimal (${MAX_FOLDER_DEPTH}).`,
    };
  }

  const environments: Environment[] = [];
  if (Array.isArray(json.environments)) {
    for (const rawEnv of json.environments) {
      const parsedEnv = parseBrunoEnvironmentObj(rawEnv);
      if (parsedEnv.ok && parsedEnv.environment.variables.length > 0) {
        environments.push(parsedEnv.environment);
      }
    }
  }

  // Also extract collection-level root vars if present
  const rootVars = json.root?.request?.vars?.req;
  if (Array.isArray(rootVars) && rootVars.length > 0) {
    const parsedRootEnv = parseBrunoEnvironmentObj({
      name: `${collectionName} (Vars)`,
      variables: rootVars.map((v) => ({
        name: v.name,
        value: v.value,
        enabled: v.enabled,
      })),
    });
    if (parsedRootEnv.ok && parsedRootEnv.environment.variables.length > 0) {
      environments.push(parsedRootEnv.environment);
    }
  }

  if (collected.length === 0) {
    return {
      ok: false,
      error: 'Tidak ada request HTTP yang ditemukan di dalam Bruno Collection JSON ini.',
    };
  }

  return {
    ok: true,
    collection: {
      id: nextUid('bcol'),
      name: collectionName,
      items: collected,
    },
    environments,
    skippedCount,
  };
}

export function parseBrunoCollectionJson(rawText: string): BrunoCollectionParseResult {
  const byteSize = new TextEncoder().encode(rawText).byteLength;
  if (byteSize > MAX_IMPORT_BYTES) {
    return { ok: false, error: `Ukuran file melebihi batas maksimal ${MAX_IMPORT_MB} MB.` };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'File Bruno JSON rusak atau bukan JSON valid.' };
  }
  return parseBrunoCollectionObject(json);
}

/* ============================================================================
 * PART 2: Native `.bru` DSL Parser (Requests, Environments, Folders)
 * ========================================================================== */

interface BruBlock {
  name: string;
  delimiter: '{' | '[';
  content: string;
}

function extractBruBlocks(rawText: string): BruBlock[] {
  const lines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks: BruBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const openMatch = line.match(/^([a-zA-Z][a-zA-Z0-9:_-]*)\s*(\{|\[)\s*$/);
    if (!openMatch) {
      i += 1;
      continue;
    }

    const blockName = openMatch[1].toLowerCase();
    const openChar = openMatch[2] as '{' | '[';
    const closeChar = openChar === '{' ? '}' : ']';

    // Raw text / code / json blocks close on a line with ONLY `}` at column 0
    const isRawBlock =
      blockName.startsWith('body:') ||
      blockName.startsWith('script:') ||
      blockName === 'tests' ||
      blockName === 'docs';

    const contentLines: string[] = [];
    i += 1;
    let depth = 1;

    while (i < lines.length) {
      const curr = lines[i];
      if (isRawBlock) {
        if (curr === closeChar) {
          i += 1;
          break;
        }
        contentLines.push(curr);
      } else {
        if (curr.trim() === closeChar) {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        contentLines.push(curr);
      }
      i += 1;
    }

    blocks.push({
      name: blockName,
      delimiter: openChar,
      content: contentLines.join('\n'),
    });
  }

  return blocks;
}

function dedentBlock(content: string): string {
  const lines = content.split('\n');
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = line.match(/^(\s*)/);
    const len = match ? match[1].length : 0;
    if (len < minIndent) minIndent = len;
  }
  if (!Number.isFinite(minIndent)) return '';
  return lines.map((l) => l.slice(minIndent)).join('\n').trim();
}

function parseBruKeyValueLines(
  content: string,
): Array<{ key: string; value: string; enabled: boolean }> {
  const rows: Array<{ key: string; value: string; enabled: boolean }> = [];
  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    let rawKey = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    let enabled = true;
    if (rawKey.startsWith('~')) {
      enabled = false;
      rawKey = rawKey.slice(1).trim();
    }
    if (!rawKey) continue;
    rows.push({ key: rawKey, value, enabled });
  }
  return rows;
}

function parseBruSecretList(content: string): Array<{ key: string; enabled: boolean }> {
  const items: Array<{ key: string; enabled: boolean }> = [];
  for (const rawLine of content.split('\n')) {
    const cleaned = rawLine.trim().replace(/,$/, '').trim();
    if (!cleaned) continue;
    if (cleaned.startsWith('~')) {
      const key = cleaned.slice(1).trim();
      if (key) items.push({ key, enabled: false });
    } else {
      items.push({ key: cleaned, enabled: true });
    }
  }
  return items;
}

function extractBruAuthFromBlocks(
  blocks: Map<string, BruBlock>,
  authModeHint: string | undefined,
  inherited?: InheritedBrunoContext,
): { header?: { key: string; value: string }; query?: { key: string; value: string } } {
  const mode = (authModeHint ?? '').toLowerCase();

  if (mode === 'none') return {};

  const bearerBlock = blocks.get('auth:bearer');
  if (mode === 'bearer' || (!mode && bearerBlock)) {
    if (bearerBlock) {
      const kv = parseBruKeyValueLines(bearerBlock.content);
      const token = kv.find((r) => r.key.toLowerCase() === 'token' && r.enabled)?.value;
      if (token) return { header: { key: 'Authorization', value: `Bearer ${token}` } };
    }
  }

  const basicBlock = blocks.get('auth:basic');
  if (mode === 'basic' || (!mode && basicBlock)) {
    if (basicBlock) {
      const kv = parseBruKeyValueLines(basicBlock.content);
      const username = kv.find((r) => r.key.toLowerCase() === 'username' && r.enabled)?.value ?? '';
      const password = kv.find((r) => r.key.toLowerCase() === 'password' && r.enabled)?.value ?? '';
      if (username || password) {
        return { header: { key: 'Authorization', value: encodeBasicAuth(username, password) } };
      }
    }
  }

  const apiKeyBlock = blocks.get('auth:apikey');
  if (mode === 'apikey' || (!mode && apiKeyBlock)) {
    if (apiKeyBlock) {
      const kv = parseBruKeyValueLines(apiKeyBlock.content);
      const key = kv.find((r) => r.key.toLowerCase() === 'key' && r.enabled)?.value ?? '';
      const value = kv.find((r) => r.key.toLowerCase() === 'value' && r.enabled)?.value ?? '';
      const placement = (
        kv.find((r) => r.key.toLowerCase() === 'placement' && r.enabled)?.value ?? 'header'
      ).toLowerCase();
      if (key) {
        if (placement === 'queryparams' || placement === 'query') {
          return { query: { key, value } };
        }
        return { header: { key, value } };
      }
    }
  }

  if (mode === 'inherit' || !mode) {
    return {
      header: inherited?.authHeader,
      query: inherited?.authQuery,
    };
  }

  return {};
}

export function parseBruEnvironment(rawText: string, fileName = 'Bruno Environment.bru'): BrunoEnvironmentParseResult {
  const blocks = extractBruBlocks(rawText);
  const blockMap = new Map(blocks.map((b) => [b.name, b]));

  const varsBlock = blockMap.get('vars');
  const secretBlock = blockMap.get('vars:secret');
  if (!varsBlock && !secretBlock) {
    return {
      ok: false,
      error: 'File .bru ini tidak memiliki blok "vars" maupun "vars:secret".',
    };
  }

  const variables: EnvVariable[] = [];
  const varByKey = new Map<string, EnvVariable>();
  let secretFlaggedCount = 0;

  if (varsBlock) {
    for (const row of parseBruKeyValueLines(varsBlock.content)) {
      const isSecret = SECRET_KEY_PATTERN.test(row.key);
      if (isSecret) secretFlaggedCount += 1;
      const entry: EnvVariable = {
        id: nextUid('envv'),
        enabled: row.enabled,
        key: row.key,
        type: isSecret ? 'secret' : 'default',
        initialValue: isSecret ? '' : row.value,
        currentValue: row.value,
      };
      varByKey.set(row.key, entry);
      variables.push(entry);
    }
  }

  if (secretBlock) {
    for (const sec of parseBruSecretList(secretBlock.content)) {
      const existing = varByKey.get(sec.key);
      if (existing) {
        if (existing.type !== 'secret') {
          existing.type = 'secret';
          existing.initialValue = '';
          secretFlaggedCount += 1;
        }
      } else {
        secretFlaggedCount += 1;
        const entry: EnvVariable = {
          id: nextUid('envv'),
          enabled: sec.enabled,
          key: sec.key,
          type: 'secret',
          initialValue: '',
          currentValue: '',
        };
        varByKey.set(sec.key, entry);
        variables.push(entry);
      }
    }
  }

  const baseName = fileName.split(/[\\/]/).pop()?.replace(/\.bru$/i, '') || 'Bruno Environment';

  return {
    ok: true,
    environment: {
      id: nextUid('env'),
      name: baseName,
      variables,
    },
    secretFlaggedCount,
  };
}

export function parseBruRequest(
  rawText: string,
  filePath = 'Request.bru',
  inherited?: InheritedBrunoContext,
  folderPathOverride?: string[],
): BruRequestParseResult {
  const blocks = extractBruBlocks(rawText);
  const blockMap = new Map(blocks.map((b) => [b.name, b]));

  const methodBlock = BRU_HTTP_METHODS.map((m) => blockMap.get(m)).find(Boolean);
  if (!methodBlock) {
    return {
      ok: false,
      error: 'File .bru ini tidak memiliki blok HTTP method (get/post/put/patch/delete).',
    };
  }

  const warnings: string[] = [];
  const { method, warning: methodWarning } = normalizeMethod(methodBlock.name);
  if (methodWarning) warnings.push(methodWarning);

  const metaKv = blockMap.has('meta') ? parseBruKeyValueLines(blockMap.get('meta')!.content) : [];
  const methodKv = parseBruKeyValueLines(methodBlock.content);

  const fallbackName = filePath.split(/[\\/]/).pop()?.replace(/\.bru$/i, '') || 'Untitled';
  const name = metaKv.find((r) => r.key.toLowerCase() === 'name')?.value || fallbackName;
  const rawUrl = methodKv.find((r) => r.key.toLowerCase() === 'url')?.value ?? '';
  const authModeHint = methodKv.find((r) => r.key.toLowerCase() === 'auth')?.value;
  const bodyModeHint = (methodKv.find((r) => r.key.toLowerCase() === 'body')?.value ?? '').toLowerCase();

  const { baseUrl, inlineQuery } = stripQueryFromUrl(rawUrl);

  const queryBlock = blockMap.get('params:query') ?? blockMap.get('query');
  const rawQueryRows: KeyValueRow[] = [];
  if (queryBlock) {
    for (const q of parseBruKeyValueLines(queryBlock.content)) {
      rawQueryRows.push({
        id: nextUid('qp'),
        enabled: q.enabled,
        key: q.key,
        value: q.value,
        description: '',
      });
    }
  } else {
    for (const iq of inlineQuery) {
      rawQueryRows.push({
        id: nextUid('qp'),
        enabled: true,
        key: iq.key,
        value: iq.value,
        description: '',
      });
    }
  }

  const pathBlock = blockMap.get('params:path');
  const pathParams = pathBlock
    ? parseBruKeyValueLines(pathBlock.content)
        .filter((p) => p.enabled)
        .map((p) => ({ key: p.key, value: p.value }))
    : [];

  const resolvedAuth = extractBruAuthFromBlocks(blockMap, authModeHint, inherited);
  if (resolvedAuth.query) {
    rawQueryRows.push({
      id: nextUid('qp'),
      enabled: true,
      key: resolvedAuth.query.key,
      value: resolvedAuth.query.value,
      description: 'API Key auth (Bruno)',
    });
  }

  const finalUrl = applyPathParamsToUrl(baseUrl, pathParams, warnings);
  const queryParams = dedupeQueryRows(rawQueryRows, warnings);

  const rawHeaderRows: KeyValueRow[] = [];
  const bruAuthNone = (authModeHint ?? '').toLowerCase() === 'none';
  for (const ih of inherited?.headers ?? []) {
    if (bruAuthNone && CREDENTIAL_HEADER_NAMES.has(ih.key.trim().toLowerCase())) {
      continue;
    }
    rawHeaderRows.push({
      id: nextUid('hd'),
      enabled: ih.enabled,
      key: ih.key,
      value: ih.value,
      description: 'Diwarisi dari collection.bru / folder.bru',
    });
  }
  const headersBlock = blockMap.get('headers');
  if (headersBlock) {
    for (const h of parseBruKeyValueLines(headersBlock.content)) {
      rawHeaderRows.push({
        id: nextUid('hd'),
        enabled: h.enabled,
        key: h.key,
        value: h.value,
        description: '',
      });
    }
  }
  if (
    resolvedAuth.header &&
    !rawHeaderRows.some(
      (h) => h.enabled && h.key.toLowerCase() === resolvedAuth.header!.key.toLowerCase(),
    )
  ) {
    rawHeaderRows.push({
      id: nextUid('hd'),
      enabled: true,
      key: resolvedAuth.header.key,
      value: resolvedAuth.header.value,
      description: 'Diimport dari Bruno Auth',
    });
    const modeLower = (authModeHint ?? '').toLowerCase();
    if ((modeLower === 'inherit' || !modeLower) && /^https?:\/\//i.test(finalUrl.trim())) {
      warnings.push('Auth diwarisi dari collection.bru/folder.bru ke URL eksplisit: pastikan domain tepercaya.');
    }
  }
  const headers = dedupeHeadersCaseInsensitive(rawHeaderRows, warnings);

  let bodyText = '';
  if (method !== 'GET' && bodyModeHint !== 'none') {
    if (blockMap.has('body:json')) {
      bodyText = dedentBlock(blockMap.get('body:json')!.content);
      if (bodyText && !validateJsonTemplateSyntax(bodyText).ok) {
        warnings.push('Body JSON pada file .bru tidak valid atau butuh penyesuaian.');
      }
    } else if (blockMap.has('body:text')) {
      bodyText = dedentBlock(blockMap.get('body:text')!.content);
      if (bodyText && !validateJsonTemplateSyntax(bodyText).ok) {
        warnings.push('Body bertipe text dari .bru bukan JSON valid (backend ACF hanya menerima JSON).');
      }
    } else if (blockMap.has('body:form-urlencoded')) {
      const obj: Record<string, string> = {};
      for (const f of parseBruKeyValueLines(blockMap.get('body:form-urlencoded')!.content)) {
        if (!f.enabled) continue;
        obj[f.key] = f.value;
      }
      bodyText = JSON.stringify(obj, null, 2);
      warnings.push('Body form-urlencoded dari .bru dikonversi ke JSON.');
    } else if (blockMap.has('body:multipart-form')) {
      const obj: Record<string, string> = {};
      let skippedFiles = 0;
      for (const f of parseBruKeyValueLines(blockMap.get('body:multipart-form')!.content)) {
        if (!f.enabled) continue;
        if (f.value.startsWith('@file(')) {
          skippedFiles += 1;
          continue;
        }
        obj[f.key] = f.value;
      }
      bodyText = JSON.stringify(obj, null, 2);
      warnings.push(
        skippedFiles > 0
          ? `Body multipart-form dari .bru dikonversi ke JSON (${skippedFiles} field file dilewati).`
          : 'Body multipart-form dari .bru dikonversi ke JSON.',
      );
    }
  }

  const bruPostScript = [
    blockMap.get('script:post-response')?.content ?? '',
    blockMap.get('tests')?.content ?? '',
  ]
    .filter(Boolean)
    .join('\n');
  const bruRules = extractPostResponseVarRulesFromScript(bruPostScript);
  if (bruRules.rules.length > 0) {
    const names = bruRules.rules.map((r) => `{{${r.varName}}}`).join(', ');
    warnings.push(`Auto-sync variabel (${names}) diimport dari script Bruno.`);
  }
  if (blockMap.has('script:pre-request') || bruRules.hasUnhandledScripts) {
    warnings.push('Script/Tests Bruno lainnya diabaikan; atur validasi di tab Assertions.');
  }
  if (blockMap.has('assert')) {
    warnings.push('Blok assert .bru tidak diimport otomatis; atur manual di tab Assertions.');
  }

  addUnresolvedPlaceholderWarning(finalUrl, headers, queryParams, bodyText, warnings);

  const normalizedSegments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const derivedFolder =
    folderPathOverride ?? (normalizedSegments.length > 1 ? normalizedSegments.slice(0, -1) : []);

  return {
    ok: true,
    item: {
      id: nextUid('breq'),
      name,
      folderPath: derivedFolder,
      method,
      url: finalUrl,
      queryParams,
      headers,
      bodyText,
      warnings,
      ...(bruRules.rules.length > 0 ? { postResponseVars: bruRules.rules } : {}),
    },
  };
}

function parseBruContextFile(
  rawText: string,
  parent?: InheritedBrunoContext,
): { context: InheritedBrunoContext; preReqVars: EnvVariable[] } {
  const blocks = extractBruBlocks(rawText);
  const blockMap = new Map(blocks.map((b) => [b.name, b]));
  const auth = extractBruAuthFromBlocks(blockMap, undefined, parent);

  const headers: Array<{ key: string; value: string; enabled: boolean }> = [
    ...(parent?.headers ?? []),
  ];
  const hBlock = blockMap.get('headers');
  if (hBlock) {
    for (const h of parseBruKeyValueLines(hBlock.content)) {
      headers.push(h);
    }
  }

  const preReqVars: EnvVariable[] = [];
  const varsBlock = blockMap.get('vars:pre-request');
  if (varsBlock) {
    for (const row of parseBruKeyValueLines(varsBlock.content)) {
      const isSecret = SECRET_KEY_PATTERN.test(row.key);
      preReqVars.push({
        id: nextUid('envv'),
        enabled: row.enabled,
        key: row.key,
        type: isSecret ? 'secret' : 'default',
        initialValue: isSecret ? '' : row.value,
        currentValue: row.value,
      });
    }
  }

  return {
    context: {
      authHeader: auth.header,
      authQuery: auth.query,
      headers,
    },
    preReqVars,
  };
}

export function parseBrunoCollectionFiles(
  files: Array<{ path: string; content: string }>,
  fallbackName = 'Imported Bruno Collection',
): BrunoFilesAssembleResult {
  if (files.length === 0) {
    return { ok: false, error: 'Tidak ada file Bruno yang ditemukan.' };
  }

  const normalized = files
    .map((f) => ({
      path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''),
      content: f.content,
    }))
    .filter((f) => {
      const segs = f.path.split('/').filter(Boolean);
      return segs.length > 0 && segs.every((s) => s !== '.' && s !== '..');
    });

  if (normalized.length === 0) {
    return { ok: false, error: 'Tidak ada path file Bruno yang valid.' };
  }

  // Strip common top-level root folder (e.g. "sidigs-bruno/") if all files share one
  const splitPaths = normalized.map((f) => f.path.split('/').filter(Boolean));
  let commonPrefix = '';
  if (splitPaths.length > 0 && splitPaths.every((parts) => parts.length > 1 && parts[0] === splitPaths[0][0])) {
    commonPrefix = splitPaths[0][0];
  }

  const relFiles = normalized.map((f) => ({
    path: commonPrefix ? f.path.slice(commonPrefix.length + 1) : f.path,
    content: f.content,
  }));

  let collectionName = commonPrefix || fallbackName;
  const brunoJsonFile = relFiles.find((f) => f.path.toLowerCase() === 'bruno.json' || f.path.toLowerCase().endsWith('/bruno.json'));
  if (brunoJsonFile) {
    try {
      const parsedMeta = JSON.parse(brunoJsonFile.content) as { name?: string };
      if (parsedMeta.name && parsedMeta.name.trim()) {
        collectionName = parsedMeta.name.trim();
      }
    } catch {
      // Ignore malformed bruno.json
    }
  }

  // Parse collection.bru and folder.bru context files by directory path
  const contextByDir = new Map<string, { raw: string }>();
  for (const f of relFiles) {
    const lower = f.path.toLowerCase();
    const base = lower.split('/').pop() ?? '';
    if (base === 'collection.bru') {
      contextByDir.set('', { raw: f.content });
    } else if (base === 'folder.bru') {
      const dir = f.path.split('/').slice(0, -1).join('/');
      contextByDir.set(dir, { raw: f.content });
    }
  }

  const rootParsed = contextByDir.has('')
    ? parseBruContextFile(contextByDir.get('')!.raw)
    : { context: {} as InheritedBrunoContext, preReqVars: [] as EnvVariable[] };

  // Memoize inherited context per folder prefix to avoid O(F*D) re-parsing.
  const folderContextCache = new Map<string, InheritedBrunoContext>([['', rootParsed.context]]);
  const getContextForFolder = (folderSegments: string[]): InheritedBrunoContext => {
    const fullKey = folderSegments.join('/');
    const cachedFull = folderContextCache.get(fullKey);
    if (cachedFull) return cachedFull;

    let ctx = rootParsed.context;
    for (let i = 0; i < folderSegments.length; i += 1) {
      const prefix = folderSegments.slice(0, i + 1).join('/');
      const cachedPrefix = folderContextCache.get(prefix);
      if (cachedPrefix) {
        ctx = cachedPrefix;
        continue;
      }
      const folderMeta = contextByDir.get(prefix);
      if (folderMeta) {
        ctx = parseBruContextFile(folderMeta.raw, ctx).context;
      }
      folderContextCache.set(prefix, ctx);
    }
    return ctx;
  };

  const items: CollectionRequestItem[] = [];
  const environments: Environment[] = [];
  const warnings: string[] = [];

  if (rootParsed.preReqVars.length > 0) {
    environments.push({
      id: nextUid('env'),
      name: `${collectionName} (Vars)`,
      variables: rootParsed.preReqVars,
    });
  }

  for (const f of relFiles) {
    if (!f.path.toLowerCase().endsWith('.bru')) continue;
    const parts = f.path.split('/').filter(Boolean);
    const fileName = parts[parts.length - 1];
    const lowerFile = fileName.toLowerCase();
    if (lowerFile === 'collection.bru' || lowerFile === 'folder.bru') continue;

    const dirSegments = parts.slice(0, -1);
    const inEnvFolder = dirSegments.some((seg) => seg.toLowerCase() === 'environments');

    if (inEnvFolder) {
      const envRes = parseBruEnvironment(f.content, fileName);
      if (envRes.ok) {
        environments.push(envRes.environment);
      } else {
        warnings.push(`${f.path}: ${envRes.error}`);
      }
      continue;
    }

    const inherited = getContextForFolder(dirSegments);
    const reqRes = parseBruRequest(f.content, f.path, inherited, dirSegments);
    if (reqRes.ok) {
      items.push(reqRes.item);
    } else {
      // Fallback: check if it's an environment .bru outside environments/
      const envFallback = parseBruEnvironment(f.content, fileName);
      if (envFallback.ok) {
        environments.push(envFallback.environment);
      } else {
        warnings.push(`${f.path}: dilewati (${reqRes.error})`);
      }
    }
  }

  if (items.length === 0 && environments.length === 0) {
    return {
      ok: false,
      error: 'Tidak ada request HTTP maupun Environment .bru yang valid pada file yang dipilih.',
    };
  }

  return {
    ok: true,
    collection:
      items.length > 0
        ? {
            id: nextUid('bcol'),
            name: collectionName,
            items,
          }
        : null,
    environments,
    warnings,
  };
}

/* ============================================================================
 * PART 3: Unified Auto-Detect Parser (Postman JSON + Bruno JSON + .bru)
 * ========================================================================== */

export function parseAutoImportFile(fileName: string, rawText: string): AutoImportFileResult {
  const byteSize = new TextEncoder().encode(rawText).byteLength;
  if (byteSize > MAX_IMPORT_BYTES) {
    return { ok: false, error: `Ukuran file melebihi batas maksimal ${MAX_IMPORT_MB} MB.` };
  }

  const lowerName = fileName.toLowerCase();

  // Handle .bru files
  if (lowerName.endsWith('.bru')) {
    const base = lowerName.split(/[\\/]/).pop() ?? lowerName;
    if (base === 'collection.bru' || base === 'folder.bru') {
      return {
        ok: false,
        error: `${base} adalah konfigurasi folder/koleksi Bruno. Pilih folder Bruno secara utuh atau sertakan file request .bru lainnya.`,
      };
    }

    const reqRes = parseBruRequest(rawText, fileName);
    if (reqRes.ok) {
      return {
        ok: true,
        kind: 'collection',
        source: 'bruno-bru',
        collection: {
          id: nextUid('bcol'),
          name: reqRes.item.folderPath[0] ?? 'Bruno Import',
          items: [reqRes.item],
        },
        environments: [],
        skippedCount: 0,
      };
    }

    const envRes = parseBruEnvironment(rawText, fileName);
    if (envRes.ok) {
      return {
        ok: true,
        kind: 'environment',
        source: 'bruno-bru',
        environment: envRes.environment,
        secretFlaggedCount: envRes.secretFlaggedCount,
      };
    }

    return {
      ok: false,
      error: 'File .bru tidak dikenali sebagai request HTTP maupun Environment Bruno.',
    };
  }

  // Handle JSON files (Postman or Bruno)
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, error: 'File bukan JSON yang valid atau rusak.' };
  }

  // Try Bruno Collection JSON first if it matches Bruno's structure (`items` array)
  if (isBrunoCollectionObject(json)) {
    const res = parseBrunoCollectionObject(json);
    if (!res.ok) return res;
    return {
      ok: true,
      kind: 'collection',
      source: 'bruno-json',
      collection: res.collection,
      environments: res.environments,
      skippedCount: res.skippedCount,
    };
  }

  // Try Bruno Environment JSON (`variables` array with `name`)
  if (isBrunoEnvironmentObject(json)) {
    const res = parseBrunoEnvironmentObj(json);
    if (!res.ok) return res;
    return {
      ok: true,
      kind: 'environment',
      source: 'bruno-json',
      environment: res.environment,
      secretFlaggedCount: res.secretFlaggedCount,
    };
  }

  // Fall back to Postman Auto JSON (Collection v2.0/v2.1 or Environment)
  const pmRes = parsePostmanAutoJson(rawText);
  if (!pmRes.ok) {
    return {
      ok: false,
      error:
        'Format file tidak dikenali. Gunakan Postman Collection v2.1 (.json), Postman Environment (.json), Bruno Collection/Environment (.json), atau file .bru.',
    };
  }

  if (pmRes.kind === 'collection') {
    return {
      ok: true,
      kind: 'collection',
      source: 'postman',
      collection: pmRes.collection,
      environments: pmRes.collectionEnv ? [pmRes.collectionEnv] : [],
      skippedCount: pmRes.skippedCount,
    };
  }

  return {
    ok: true,
    kind: 'environment',
    source: 'postman',
    environment: pmRes.environment,
    secretFlaggedCount: pmRes.secretFlaggedCount,
  };
}
