import { ALLOWED_METHODS, type HistoryEntry, type HttpMethod } from '../types/api';

export const HISTORY_STORAGE_KEY = 'acf-history';
export const THEME_STORAGE_KEY = 'acf-theme';
export const INSPECTOR_STORAGE_KEY = 'acf-inspector-open';
export const MAX_HISTORY_ENTRIES = 50;

/** Baca preferensi buka/tutup Variables Inspector (default true). */
export function loadInspectorPreference(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): boolean {
  try {
    const raw = storage.getItem(INSPECTOR_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // Storage tidak tersedia (mis. mode privat) -> fallback default.
  }
  return true;
}

export function saveInspectorPreference(
  open: boolean,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try {
    storage.setItem(INSPECTOR_STORAGE_KEY, String(open));
  } catch {
    // Abaikan: preferensi UI tidak boleh membuat aplikasi crash.
  }
}

export function redactHistoryUrl(rawUrl: string): string {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.origin}${parsed.pathname}`.slice(0, 500);
    }
  } catch {
    // Fallback for unresolved template strings such as {{url}}/api/login?key={{secret}}
  }
  const withoutQueryOrHash = trimmed.split(/[?#]/)[0] ?? trimmed;
  return withoutQueryOrHash.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1***@').slice(0, 500);
}

/**
 * Runtime whitelist sanitizer: guarantees that ONLY the 6 allowed metadata fields
 * are ever serialized to localStorage. Headers, body, tokens, URL query keys, and userinfo are stripped.
 */
export function sanitizeHistoryEntry(input: HistoryEntry): HistoryEntry {
  const method: HttpMethod = ALLOWED_METHODS.includes(input.method) ? input.method : 'GET';
  const overallStatus: HistoryEntry['overallStatus'] =
    input.overallStatus === 'PASS' || input.overallStatus === 'FAIL' || input.overallStatus === 'ERROR'
      ? input.overallStatus
      : 'ERROR';

  return {
    method,
    url: redactHistoryUrl(String(input.url ?? '')),
    timestamp: String(input.timestamp ?? new Date().toISOString()),
    overallStatus,
    passedCount: Number.isFinite(input.passedCount) ? Math.max(0, Math.floor(input.passedCount)) : 0,
    failedCount: Number.isFinite(input.failedCount) ? Math.max(0, Math.floor(input.failedCount)) : 0,
  };
}

export function loadHistory(storage?: Pick<Storage, 'getItem'>): HistoryEntry[] {
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!store) return [];
  try {
    const raw = store.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is HistoryEntry => typeof item === 'object' && item !== null)
      .slice(0, MAX_HISTORY_ENTRIES)
      .map(sanitizeHistoryEntry);
  } catch {
    return [];
  }
}

export function appendHistoryEntry(
  entry: HistoryEntry,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): HistoryEntry[] {
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  const current = loadHistory(store);
  const next = [sanitizeHistoryEntry(entry), ...current].slice(0, MAX_HISTORY_ENTRIES);
  if (store) {
    try {
      store.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors cleanly without crashing UI
    }
  }
  return next;
}

export function clearHistory(storage?: Pick<Storage, 'removeItem'>): void {
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Ignore storage access errors
  }
}
