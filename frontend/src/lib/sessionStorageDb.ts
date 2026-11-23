import type {
  CollectionGroup,
  CollectionRequestItem,
  Environment,
  KeyValueRow,
} from '../types/api';

const DB_NAME = 'acf-workbench-db';
const DB_VERSION = 1;
const STORE_NAME = 'workspace';
const SNAPSHOT_KEY = 'snapshot';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
]);

/** Matches pure template placeholders such as "{{token}}" or "Bearer {{$.data.token}}". */
const TEMPLATE_ONLY_VALUE = /^(?:(?:Bearer|Basic|Token)\s+)?\{\{[^{}]+\}\}$/i;

export interface PersistedWorkspaceSnapshot {
  collections: CollectionGroup[];
  environments: Environment[];
  activeEnvId: string | null;
  savedAt: string;
}

function sanitizeHeaderRowForLocalDb(row: KeyValueRow): KeyValueRow {
  const lower = row.key.trim().toLowerCase();
  if (!SENSITIVE_HEADER_NAMES.has(lower)) {
    return { ...row };
  }
  const trimmedVal = row.value.trim();
  if (trimmedVal === '' || TEMPLATE_ONLY_VALUE.test(trimmedVal)) {
    return { ...row };
  }
  // Strip hardcoded credentials while keeping template placeholders intact.
  return {
    ...row,
    value: '',
  };
}

function sanitizeRequestItemForLocalDb(item: CollectionRequestItem): CollectionRequestItem {
  return {
    ...item,
    folderPath: [...item.folderPath],
    headers: item.headers.map(sanitizeHeaderRowForLocalDb),
    queryParams: item.queryParams.map((q) => ({ ...q })),
    warnings: [...item.warnings],
  };
}

export function sanitizeCollectionForLocalDb(col: CollectionGroup): CollectionGroup {
  return {
    id: col.id,
    name: col.name,
    items: col.items.map(sanitizeRequestItemForLocalDb),
  };
}

export function sanitizeEnvironmentForLocalDb(env: Environment): Environment {
  return {
    id: env.id,
    name: env.name,
    variables: env.variables.map((v) =>
      v.type === 'secret'
        ? { ...v, initialValue: '', currentValue: '' }
        : { ...v },
    ),
  };
}

/**
 * Sanitize workspace state before persisting to browser IndexedDB:
 * - Secret environment variables are always cleared (initialValue & currentValue = '').
 * - Hardcoded sensitive header values (Authorization, Cookie, X-API-Key, etc.) are cleared,
 *   while template placeholders like "Bearer {{$.data.token}}" are preserved.
 * - Dangling activeEnvId references are reset to null.
 */
export function sanitizeWorkspaceSnapshot(input: {
  collections: CollectionGroup[];
  environments: Environment[];
  activeEnvId: string | null;
}): PersistedWorkspaceSnapshot {
  const environments = input.environments.map(sanitizeEnvironmentForLocalDb);
  const validEnvIds = new Set(environments.map((e) => e.id));
  const activeEnvId =
    input.activeEnvId && validEnvIds.has(input.activeEnvId) ? input.activeEnvId : null;

  return {
    collections: input.collections.map(sanitizeCollectionForLocalDb),
    environments,
    activeEnvId,
    savedAt: new Date().toISOString(),
  };
}

function openWorkspaceDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadWorkspaceFromDb(): Promise<PersistedWorkspaceSnapshot | null> {
  const db = await openWorkspaceDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(SNAPSHOT_KEY);

      req.onsuccess = () => {
        const raw = req.result as Partial<PersistedWorkspaceSnapshot> | undefined;
        if (!raw || !Array.isArray(raw.collections) || !Array.isArray(raw.environments)) {
          resolve(null);
          return;
        }
        resolve(
          sanitizeWorkspaceSnapshot({
            collections: raw.collections,
            environments: raw.environments,
            activeEnvId: typeof raw.activeEnvId === 'string' ? raw.activeEnvId : null,
          }),
        );
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function saveWorkspaceToDb(input: {
  collections: CollectionGroup[];
  environments: Environment[];
  activeEnvId: string | null;
}): Promise<boolean> {
  const db = await openWorkspaceDb();
  if (!db) return false;

  const sanitized = sanitizeWorkspaceSnapshot(input);

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(sanitized, SNAPSHOT_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

export async function clearWorkspaceDb(): Promise<void> {
  const db = await openWorkspaceDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(SNAPSHOT_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
