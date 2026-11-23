import { MAX_IMPORT_BYTES, MAX_IMPORT_MB } from './postmanImport';

export type ParsedGitHubTarget = {
  kind: 'repo' | 'tree' | 'blob' | 'raw';
  owner: string;
  repo: string;
  ref?: string;
  path: string;
};

export type ParseGitHubUrlResult =
  | { ok: true; target: ParsedGitHubTarget }
  | { ok: false; error: string };

export interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | string;
  size?: number;
}

export interface DiscoveredBrunoCollection {
  id: string;
  rootPath: string;
  label: string;
  filePaths: string[];
  hasBrunoJson: boolean;
}

export interface DiscoveredJsonFile {
  path: string;
  size: number;
  priority: number;
}

export interface DiscoveredGitHubTargets {
  brunoCollections: DiscoveredBrunoCollection[];
  jsonFiles: DiscoveredJsonFile[];
}

export type InspectGitHubResult =
  | {
      ok: true;
      mode: 'single-file';
      owner: string;
      repo: string;
      ref: string;
      fileName: string;
      path: string;
      content: string;
    }
  | {
      ok: true;
      mode: 'tree';
      owner: string;
      repo: string;
      ref: string;
      baseSubpath: string;
      brunoCollections: DiscoveredBrunoCollection[];
      jsonFiles: DiscoveredJsonFile[];
      truncated: boolean;
    }
  | { ok: false; error: string };

const MAX_GITHUB_BRUNO_FILES = 250;
const FETCH_CONCURRENCY = 6;

const IGNORED_JSON_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'jsconfig.json',
  'composer.json',
  'composer.lock',
  'deno.json',
  'deno.lock',
  'pnpm-lock.json',
  'renovate.json',
  'vercel.json',
  'netlify.json',
  'manifest.json',
  'components.json',
  'turbo.json',
  'nx.json',
  'lerna.json',
  'biome.json',
  'angular.json',
  'bruno.json',
]);

const IGNORED_PATH_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  '.idea',
  'dist',
  'build',
  '.next',
  '.astro',
  'vendor',
  'coverage',
]);

function cleanRepoName(raw: string): string {
  return raw.replace(/\.git$/i, '').trim();
}

function isValidGitHubSegment(seg: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(seg) && seg !== '.' && seg !== '..';
}

export function isValidGitHubRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false;
  if (!/^[a-zA-Z0-9._/-]+$/.test(ref)) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.includes('//')) return false;
  const parts = ref.split('/');
  return parts.every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function sanitizeGitHubPath(rawPath: string): string | null {
  if (!rawPath) return '';
  if (rawPath.includes('\\') || /[\x00-\x1f\x7f?#]/.test(rawPath)) return null;
  const normalized = rawPath.replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';
  const segments = normalized.split('/');
  const safeSegments: string[] = [];
  for (const rawSeg of segments) {
    if (!rawSeg) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSeg);
    } catch {
      return null;
    }
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      /[\x00-\x1f\x7f?#]/.test(decoded)
    ) {
      return null;
    }
    safeSegments.push(decoded);
  }
  return safeSegments.join('/');
}

function safeDecodeSegment(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

export function parseGitHubUrl(rawInput: string): ParseGitHubUrlResult {
  const input = rawInput.trim();
  if (!input) {
    return { ok: false, error: 'Masukkan URL repository, folder, atau file GitHub terlebih dahulu.' };
  }

  // Shorthand: owner/repo or owner/repo/subpath
  if (!/^https?:\/\//i.test(input) && !input.includes('://')) {
    const cleaned = input.replace(/^\/+|\/+$/g, '');
    const parts = cleaned.split('/').filter(Boolean);
    if (parts.length >= 2 && isValidGitHubSegment(parts[0]) && isValidGitHubSegment(cleanRepoName(parts[1]))) {
      const owner = parts[0];
      const repo = cleanRepoName(parts[1]);
      const rest = sanitizeGitHubPath(parts.slice(2).join('/'));
      if (rest === null) {
        return { ok: false, error: 'Path GitHub mengandung segmen traversal atau karakter tidak valid.' };
      }
      return {
        ok: true,
        target: {
          kind: rest ? 'tree' : 'repo',
          owner,
          repo,
          ref: undefined,
          path: rest,
        },
      };
    }
    return {
      ok: false,
      error: 'Format URL GitHub tidak valid. Contoh: https://github.com/owner/repo atau owner/repo.',
    };
  }

  const rawPathCheck = input.replace(/^https?:\/\/[^/?#]+/i, '').split(/[?#]/)[0] ?? '';
  if (rawPathCheck.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/.test(rawPathCheck)) {
    return { ok: false, error: 'URL GitHub mengandung segmen traversal tidak valid.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'URL GitHub tidak valid.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Hanya URL https://github.com atau https://raw.githubusercontent.com yang didukung.' };
  }

  const host = parsed.hostname.toLowerCase();
  const rawSegments = parsed.pathname.split('/').filter(Boolean);
  const segments: string[] = [];
  for (const seg of rawSegments) {
    const decoded = safeDecodeSegment(seg);
    if (decoded === null) {
      return { ok: false, error: 'URL GitHub memuat karakter encoding persen yang tidak valid.' };
    }
    segments.push(decoded);
  }

  if (host === 'raw.githubusercontent.com') {
    if (segments.length < 4) {
      return {
        ok: false,
        error: 'URL raw.githubusercontent.com tidak lengkap (harus memuat owner/repo/branch/path).',
      };
    }
    const [owner, rawRepo, ref, ...rest] = segments;
    const repo = cleanRepoName(rawRepo);
    if (!isValidGitHubSegment(owner) || !isValidGitHubSegment(repo)) {
      return { ok: false, error: 'Nama owner atau repository GitHub tidak valid.' };
    }
    if (!isValidGitHubRef(ref)) {
      return { ok: false, error: 'Nama branch/ref GitHub tidak valid.' };
    }
    const safePath = sanitizeGitHubPath(rest.join('/'));
    if (!safePath) {
      return { ok: false, error: 'Path file pada URL GitHub mengandung segmen tidak valid.' };
    }
    return {
      ok: true,
      target: {
        kind: 'raw',
        owner,
        repo,
        ref,
        path: safePath,
      },
    };
  }

  if (host !== 'github.com' && host !== 'www.github.com') {
    return {
      ok: false,
      error: 'Host harus github.com atau raw.githubusercontent.com.',
    };
  }

  if (segments.length < 2) {
    return { ok: false, error: 'URL GitHub harus memuat minimal owner dan nama repository.' };
  }

  const owner = segments[0];
  const repo = cleanRepoName(segments[1]);
  if (!isValidGitHubSegment(owner) || !isValidGitHubSegment(repo)) {
    return { ok: false, error: 'Nama owner atau repository GitHub tidak valid.' };
  }

  if (segments.length === 2) {
    return {
      ok: true,
      target: { kind: 'repo', owner, repo, ref: undefined, path: '' },
    };
  }

  const marker = segments[2];
  if (marker === 'tree' && segments.length >= 4) {
    const ref = segments[3];
    if (!isValidGitHubRef(ref)) {
      return { ok: false, error: 'Nama branch/ref GitHub tidak valid.' };
    }
    const safePath = sanitizeGitHubPath(segments.slice(4).join('/'));
    if (safePath === null) {
      return { ok: false, error: 'Path folder GitHub mengandung segmen traversal tidak valid.' };
    }
    return {
      ok: true,
      target: {
        kind: 'tree',
        owner,
        repo,
        ref,
        path: safePath,
      },
    };
  }

  if ((marker === 'blob' || marker === 'raw') && segments.length >= 5) {
    const ref = segments[3];
    if (!isValidGitHubRef(ref)) {
      return { ok: false, error: 'Nama branch/ref GitHub tidak valid.' };
    }
    const safePath = sanitizeGitHubPath(segments.slice(4).join('/'));
    if (!safePath) {
      return { ok: false, error: 'Path file GitHub mengandung segmen traversal tidak valid.' };
    }
    return {
      ok: true,
      target: {
        kind: marker,
        owner,
        repo,
        ref,
        path: safePath,
      },
    };
  }

  return {
    ok: true,
    target: { kind: 'repo', owner, repo, ref: undefined, path: '' },
  };
}

function isIgnoredPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    if (IGNORED_PATH_SEGMENTS.has(part.toLowerCase())) return true;
  }
  const base = (parts[parts.length - 1] ?? '').toLowerCase();
  if (IGNORED_JSON_BASENAMES.has(base)) return true;
  if (base.startsWith('tsconfig.') && base.endsWith('.json')) return true;
  if (base.startsWith('.eslintrc') || base.startsWith('.prettierrc')) return true;
  return false;
}

function scoreJsonFilePath(path: string): number {
  const lower = path.toLowerCase();
  let score = 0;
  if (lower.includes('postman_collection') || lower.includes('postman-collection')) score += 100;
  if (lower.includes('postman_environment') || lower.includes('postman-environment')) score += 90;
  if (lower.includes('postman')) score += 60;
  if (lower.includes('bruno')) score += 60;
  if (lower.includes('collection')) score += 40;
  if (lower.includes('environment') || lower.includes('env')) score += 30;
  if (lower.includes('api')) score += 15;
  return score;
}

export function discoverGitHubImportTargets(
  entries: GitHubTreeEntry[],
  baseSubpath = '',
): DiscoveredGitHubTargets {
  const normalizedBase = baseSubpath.replace(/^\/+|\/+$/g, '');
  const prefix = normalizedBase ? `${normalizedBase}/` : '';

  const blobs = entries.filter((e) => {
    if (e.type !== 'blob' || !e.path) return false;
    if (prefix && e.path !== normalizedBase && !e.path.startsWith(prefix)) return false;
    const parts = e.path.split('/').filter(Boolean);
    return !parts.slice(0, -1).some((p) => IGNORED_PATH_SEGMENTS.has(p.toLowerCase()));
  });

  // 1. Find Bruno collection roots via bruno.json
  const brunoJsonDirs = blobs
    .filter((b) => {
      const base = b.path.split('/').pop()?.toLowerCase();
      return base === 'bruno.json';
    })
    .map((b) => b.path.split('/').slice(0, -1).join('/'))
    .sort((a, b) => b.length - a.length); // deepest first for matching

  const bruFiles = blobs.filter((b) => b.path.toLowerCase().endsWith('.bru'));
  const brunoMap = new Map<string, { hasBrunoJson: boolean; files: Set<string> }>();

  for (const dir of brunoJsonDirs) {
    const brunoMetaPath = dir ? `${dir}/bruno.json` : 'bruno.json';
    brunoMap.set(dir, { hasBrunoJson: true, files: new Set([brunoMetaPath]) });
  }

  for (const bf of bruFiles) {
    let matchedRoot: string | null = null;
    for (const dir of brunoJsonDirs) {
      if (dir === '' || bf.path.startsWith(`${dir}/`)) {
        matchedRoot = dir;
        break;
      }
    }
    if (matchedRoot === null) {
      // Group loose .bru files under baseSubpath (or top folder)
      matchedRoot = normalizedBase;
    }
    const existing = brunoMap.get(matchedRoot) ?? { hasBrunoJson: false, files: new Set<string>() };
    existing.files.add(bf.path);
    brunoMap.set(matchedRoot, existing);
  }

  const brunoCollections: DiscoveredBrunoCollection[] = Array.from(brunoMap.entries())
    .filter(([, meta]) => Array.from(meta.files).some((p) => p.toLowerCase().endsWith('.bru')))
    .map(([rootPath, meta]) => ({
      id: `bruno:${rootPath || '/'}`,
      rootPath,
      label: rootPath || '(Root Repository)',
      filePaths: Array.from(meta.files).sort(),
      hasBrunoJson: meta.hasBrunoJson,
    }))
    .sort((a, b) => a.rootPath.localeCompare(b.rootPath));

  // 2. Find candidate JSON files
  const jsonFiles: DiscoveredJsonFile[] = blobs
    .filter((b) => b.path.toLowerCase().endsWith('.json') && !isIgnoredPath(b.path))
    .map((b) => ({
      path: b.path,
      size: b.size ?? 0,
      priority: scoreJsonFilePath(b.path),
    }))
    .sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path));

  return { brunoCollections, jsonFiles };
}

function buildGitHubHeaders(token?: string, accept = 'application/vnd.github+json'): HeadersInit {
  const headers: Record<string, string> = {
    Accept: accept,
  };
  if (token && token.trim() !== '') {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function formatGitHubError(status: number, remainingRateLimit: string | null, hasToken: boolean): string {
  if (status === 401) {
    return 'GitHub Token (PAT) tidak valid atau sudah kedaluwarsa (HTTP 401).';
  }
  if (status === 403 && remainingRateLimit === '0') {
    return hasToken
      ? 'Batas rate limit GitHub API tercapai (HTTP 403). Coba lagi beberapa saat.'
      : 'Batas GitHub API tanpa token (60 req/jam) tercapai. Masukkan GitHub Token (PAT) sementara atau gunakan URL file langsung.';
  }
  if (status === 404) {
    return hasToken
      ? 'Repository, branch, atau path tidak ditemukan di GitHub (HTTP 404). Periksa URL dan nama branch.'
      : 'Repository tidak ditemukan atau bersifat privat (HTTP 404). Jika repo privat, masukkan GitHub Token (PAT) sementara.';
  }
  return `GitHub mengembalikan error HTTP ${status}.`;
}

function encodeGitHubPath(path: string): string | null {
  const sanitized = sanitizeGitHubPath(path);
  if (!sanitized) return null;
  return sanitized
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function assertGitHubUrl(
  urlStr: string,
  expectedOrigin: 'https://api.github.com' | 'https://raw.githubusercontent.com',
  expectedPathPrefix: string,
): void {
  const checked = new URL(urlStr);
  if (checked.origin !== expectedOrigin || !checked.pathname.startsWith(expectedPathPrefix)) {
    throw new Error('UNSAFE_GITHUB_URL');
  }
}

async function readResponseTextWithCap(
  res: Response,
  filePath: string,
): Promise<{ ok: true; content: string; bytes: number } | { ok: false; error: string }> {
  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error: `Ukuran file ${filePath} melebihi batas maksimal ${MAX_IMPORT_MB} MB.`,
    };
  }

  if (!res.body) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_IMPORT_BYTES) {
      return { ok: false, error: `Ukuran file ${filePath} melebihi batas maksimal ${MAX_IMPORT_MB} MB.` };
    }
    return { ok: true, content: text, bytes };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMPORT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          error: `Ukuran file ${filePath} melebihi batas maksimal ${MAX_IMPORT_MB} MB.`,
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, content: new TextDecoder('utf-8', { fatal: false }).decode(merged), bytes: totalBytes };
}

async function fetchSingleGitHubFile(
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
  token?: string,
  signal?: AbortSignal,
): Promise<{ ok: true; content: string; bytes: number } | { ok: false; error: string }> {
  const cleanToken = token?.trim() ?? '';
  if (!isValidGitHubSegment(owner) || !isValidGitHubSegment(repo) || !isValidGitHubRef(ref)) {
    return { ok: false, error: 'Parameter repository atau branch GitHub tidak valid.' };
  }
  const encodedPath = encodeGitHubPath(filePath);
  if (!encodedPath) {
    return { ok: false, error: `Path file GitHub tidak valid: ${filePath}` };
  }

  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);
  const encodedRef = ref.split('/').map(encodeURIComponent).join('/');
  const expectedPrefix = cleanToken ? `/repos/${ownerEnc}/${repoEnc}/contents/` : `/${ownerEnc}/${repoEnc}/`;
  const url = cleanToken
    ? `https://api.github.com/repos/${ownerEnc}/${repoEnc}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
    : `https://raw.githubusercontent.com/${ownerEnc}/${repoEnc}/${encodedRef}/${encodedPath}`;

  try {
    assertGitHubUrl(
      url,
      cleanToken ? 'https://api.github.com' : 'https://raw.githubusercontent.com',
      expectedPrefix,
    );
  } catch {
    return { ok: false, error: 'URL unduhan GitHub ditolak oleh validasi path.' };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: cleanToken
        ? buildGitHubHeaders(cleanToken, 'application/vnd.github.raw+json')
        : undefined,
      redirect: 'manual',
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'Unduhan dari GitHub dibatalkan.' };
    }
    return {
      ok: false,
      error: 'Gagal terhubung ke GitHub. Periksa koneksi internet atau coba lagi.',
    };
  }

  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    return {
      ok: false,
      error: 'GitHub mengembalikan redirect tak terduga; permintaan dibatalkan demi keamanan kredensial.',
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: formatGitHubError(res.status, res.headers.get('x-ratelimit-remaining'), Boolean(cleanToken)),
    };
  }

  return readResponseTextWithCap(res, filePath);
}

export async function inspectGitHubTarget(
  rawUrl: string,
  options?: { token?: string; branchOverride?: string; signal?: AbortSignal },
): Promise<InspectGitHubResult> {
  const parsed = parseGitHubUrl(rawUrl);
  if (!parsed.ok) return parsed;

  const { target } = parsed;
  const cleanToken = options?.token?.trim() ?? '';
  const branchOverride = options?.branchOverride?.trim() ?? '';
  if (branchOverride && !isValidGitHubRef(branchOverride)) {
    return { ok: false, error: 'Nama branch/ref override GitHub tidak valid.' };
  }

  // Single file mode (raw or blob)
  if (target.kind === 'raw' || target.kind === 'blob') {
    const ref = branchOverride || target.ref || 'main';
    const fileRes = await fetchSingleGitHubFile(
      target.owner,
      target.repo,
      ref,
      target.path,
      cleanToken,
      options?.signal,
    );
    if (!fileRes.ok) return fileRes;
    const fileName = target.path.split('/').pop() || 'github-import.json';
    return {
      ok: true,
      mode: 'single-file',
      owner: target.owner,
      repo: target.repo,
      ref,
      fileName,
      path: target.path,
      content: fileRes.content,
    };
  }

  const ownerEnc = encodeURIComponent(target.owner);
  const repoEnc = encodeURIComponent(target.repo);
  const repoApiPrefix = `/repos/${ownerEnc}/${repoEnc}`;

  // Repo or tree mode: resolve branch if needed
  let ref = branchOverride || target.ref || '';
  if (!ref) {
    const metaUrl = `https://api.github.com${repoApiPrefix}`;
    assertGitHubUrl(metaUrl, 'https://api.github.com', repoApiPrefix);

    let repoRes: Response;
    try {
      repoRes = await fetch(metaUrl, {
        headers: buildGitHubHeaders(cleanToken),
        redirect: 'manual',
        signal: options?.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { ok: false, error: 'Pemindaian GitHub dibatalkan.' };
      }
      return { ok: false, error: 'Gagal menghubungi GitHub API. Periksa koneksi internet.' };
    }

    if (repoRes.type === 'opaqueredirect' || (repoRes.status >= 300 && repoRes.status < 400)) {
      return {
        ok: false,
        error: 'GitHub mengembalikan redirect tak terduga; permintaan dibatalkan demi keamanan kredensial.',
      };
    }

    if (!repoRes.ok) {
      return {
        ok: false,
        error: formatGitHubError(repoRes.status, repoRes.headers.get('x-ratelimit-remaining'), Boolean(cleanToken)),
      };
    }

    let repoData: { default_branch?: string };
    try {
      repoData = (await repoRes.json()) as { default_branch?: string };
    } catch {
      return { ok: false, error: 'Respons metadata repository GitHub bukan JSON valid.' };
    }
    ref = repoData.default_branch || 'main';
    if (!isValidGitHubRef(ref)) {
      return { ok: false, error: 'Nama branch default repository GitHub tidak valid.' };
    }
  }

  // Fetch recursive git tree in 1 API request
  const treeUrl = `https://api.github.com${repoApiPrefix}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  assertGitHubUrl(treeUrl, 'https://api.github.com', `${repoApiPrefix}/git/trees/`);

  let treeRes: Response;
  try {
    treeRes = await fetch(treeUrl, {
      headers: buildGitHubHeaders(cleanToken),
      redirect: 'manual',
      signal: options?.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'Pemindaian GitHub dibatalkan.' };
    }
    return { ok: false, error: 'Gagal mengambil daftar file repository dari GitHub.' };
  }

  if (treeRes.type === 'opaqueredirect' || (treeRes.status >= 300 && treeRes.status < 400)) {
    return {
      ok: false,
      error: 'GitHub mengembalikan redirect tak terduga; permintaan dibatalkan demi keamanan kredensial.',
    };
  }

  if (!treeRes.ok) {
    return {
      ok: false,
      error: formatGitHubError(treeRes.status, treeRes.headers.get('x-ratelimit-remaining'), Boolean(cleanToken)),
    };
  }

  let treeData: { tree?: GitHubTreeEntry[]; truncated?: boolean };
  try {
    treeData = (await treeRes.json()) as {
      tree?: GitHubTreeEntry[];
      truncated?: boolean;
    };
  } catch {
    return { ok: false, error: 'Respons struktur file GitHub bukan JSON valid.' };
  }
  const discovered = discoverGitHubImportTargets(treeData.tree ?? [], target.path);

  if (discovered.brunoCollections.length === 0 && discovered.jsonFiles.length === 0) {
    return {
      ok: false,
      error:
        'Tidak ditemukan file .bru (Bruno) maupun file .json (Postman/Bruno) yang cocok pada repository/folder ini.',
    };
  }

  return {
    ok: true,
    mode: 'tree',
    owner: target.owner,
    repo: target.repo,
    ref,
    baseSubpath: target.path,
    brunoCollections: discovered.brunoCollections,
    jsonFiles: discovered.jsonFiles,
    truncated: Boolean(treeData.truncated),
  };
}

export async function fetchGitHubFiles(
  owner: string,
  repo: string,
  ref: string,
  filePaths: string[],
  options?: {
    token?: string;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<{ ok: true; files: Array<{ path: string; content: string }> } | { ok: false; error: string }> {
  const limited = filePaths.slice(0, MAX_GITHUB_BRUNO_FILES);
  const results: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  let completed = 0;
  let firstError: string | null = null;
  let cursor = 0;

  const worker = async () => {
    while (cursor < limited.length && !firstError) {
      const idx = cursor;
      cursor += 1;
      const path = limited[idx];
      const fetched = await fetchSingleGitHubFile(owner, repo, ref, path, options?.token, options?.signal);
      if (!fetched.ok) {
        firstError = fetched.error;
        return;
      }
      totalBytes += fetched.bytes;
      if (totalBytes > MAX_IMPORT_BYTES) {
        firstError = `Total ukuran file dari GitHub melebihi batas maksimal ${MAX_IMPORT_MB} MB.`;
        return;
      }
      results.push({ path, content: fetched.content });
      completed += 1;
      options?.onProgress?.(completed, limited.length);
    }
  };

  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, limited.length) }, () => worker());
  await Promise.all(workers);

  if (firstError) {
    return { ok: false, error: firstError };
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, files: results };
}
