import type {
  AssertionDraft,
  CollectionRequestItem,
  ErrorPayload,
  HttpMethod,
  KeyValueRow,
  ResultPayload,
  ValidationError,
} from '../types/api';
import { INITIAL_ASSERTIONS } from './defaults';
import { nextUid } from './postmanImport';

export type RequestSubTab = 'params' | 'headers' | 'body' | 'assertions';
export type ResponseSubTab = 'assertions' | 'body' | 'headers';

export interface RequestDraftSnapshot {
  method: HttpMethod;
  url: string;
  queryParams: KeyValueRow[];
  headers: KeyValueRow[];
  bodyText: string;
  assertions: AssertionDraft[];
  importWarnings: string[];
  result: ResultPayload | null;
  errorResult: ErrorPayload | null;
}

export interface RequestTabSession {
  tabId: string;
  requestId: string | null;
  title: string;
  breadcrumb: string;
  method: HttpMethod;
  url: string;
  queryParams: KeyValueRow[];
  headers: KeyValueRow[];
  bodyText: string;
  assertions: AssertionDraft[];
  requestTab: RequestSubTab;
  importWarnings: string[];
  isLoading: boolean;
  loadingStartedAt: number | null;
  result: ResultPayload | null;
  errorResult: ErrorPayload | null;
  validationError: ValidationError | null;
  clientError: string | null;
  networkError: string | null;
  responseTab: ResponseSubTab;
}

export function cloneDraftRows(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.map((r) => ({ ...r }));
}

export function cloneAssertionDrafts(rows: AssertionDraft[]): AssertionDraft[] {
  return rows.map((a) => ({ ...a }));
}

export function createBlankTabSession(
  tabId: string = nextUid('tab'),
  initialAssertions: AssertionDraft[] = INITIAL_ASSERTIONS,
): RequestTabSession {
  return {
    tabId,
    requestId: null,
    title: 'Request Baru',
    breadcrumb: 'Request Tunggal',
    method: 'GET',
    url: '',
    queryParams: [],
    headers: [],
    bodyText: '',
    assertions: cloneAssertionDrafts(initialAssertions),
    requestTab: 'params',
    importWarnings: [],
    isLoading: false,
    loadingStartedAt: null,
    result: null,
    errorResult: null,
    validationError: null,
    clientError: null,
    networkError: null,
    responseTab: 'assertions',
  };
}

export function createTabFromCollectionItem(
  item: CollectionRequestItem,
  options?: {
    collectionName?: string;
    draft?: RequestDraftSnapshot | null;
    tabId?: string;
  },
): RequestTabSession {
  const draft = options?.draft ?? null;
  const breadcrumb =
    [options?.collectionName, ...item.folderPath, item.name].filter(Boolean).join(' / ') ||
    item.name;

  return {
    tabId: options?.tabId ?? nextUid('tab'),
    requestId: item.id,
    title: item.name,
    breadcrumb,
    method: draft ? draft.method : item.method,
    url: draft ? draft.url : item.url,
    queryParams: cloneDraftRows(draft ? draft.queryParams : item.queryParams),
    headers: cloneDraftRows(draft ? draft.headers : item.headers),
    bodyText: draft ? draft.bodyText : item.bodyText,
    assertions: cloneAssertionDrafts(draft ? draft.assertions : INITIAL_ASSERTIONS),
    requestTab: 'params',
    importWarnings: [...(draft ? draft.importWarnings : item.warnings)],
    isLoading: false,
    loadingStartedAt: null,
    result: draft ? draft.result : null,
    errorResult: draft ? draft.errorResult : null,
    validationError: null,
    clientError: null,
    networkError: null,
    responseTab: 'assertions',
  };
}

export function isPristineBlankTab(tab: RequestTabSession): boolean {
  return (
    tab.requestId === null &&
    tab.title === 'Request Baru' &&
    tab.method === 'GET' &&
    tab.url.trim() === '' &&
    tab.queryParams.length === 0 &&
    tab.headers.length === 0 &&
    tab.bodyText.trim() === '' &&
    tab.importWarnings.length === 0 &&
    !tab.isLoading &&
    tab.result === null &&
    tab.errorResult === null &&
    tab.validationError === null &&
    tab.clientError === null &&
    tab.networkError === null
  );
}

export function openOrFocusCollectionTab(
  tabs: RequestTabSession[],
  _activeTabId: string,
  item: CollectionRequestItem,
  options?: {
    collectionName?: string;
    draft?: RequestDraftSnapshot | null;
    tabId?: string;
    forceDuplicate?: boolean;
  },
): { tabs: RequestTabSession[]; activeTabId: string } {
  const existing = tabs.find((t) => t.requestId === item.id);
  if (existing && !options?.forceDuplicate) {
    return { tabs, activeTabId: existing.tabId };
  }

  const nextTab = createTabFromCollectionItem(item, options);
  if (existing && options?.forceDuplicate) {
    nextTab.requestId = null;
  }

  if (!options?.forceDuplicate && tabs.length === 1 && isPristineBlankTab(tabs[0])) {
    return { tabs: [nextTab], activeTabId: nextTab.tabId };
  }

  return { tabs: [...tabs, nextTab], activeTabId: nextTab.tabId };
}

export function duplicateRequestTab(
  tabs: RequestTabSession[],
  targetTabId: string,
  nextTabId: string = nextUid('tab'),
): { tabs: RequestTabSession[]; activeTabId: string } {
  const sourceIdx = tabs.findIndex((t) => t.tabId === targetTabId);
  if (sourceIdx < 0) {
    return { tabs, activeTabId: tabs[0]?.tabId ?? '' };
  }

  const source = tabs[sourceIdx]!;
  const copy: RequestTabSession = {
    ...source,
    tabId: nextTabId,
    requestId: null,
    queryParams: cloneDraftRows(source.queryParams),
    headers: cloneDraftRows(source.headers),
    assertions: cloneAssertionDrafts(source.assertions),
    importWarnings: [...source.importWarnings],
    isLoading: false,
    loadingStartedAt: null,
    result: null,
    errorResult: null,
    validationError: null,
    clientError: null,
    networkError: null,
  };

  const nextTabs = [
    ...tabs.slice(0, sourceIdx + 1),
    copy,
    ...tabs.slice(sourceIdx + 1),
  ];
  return { tabs: nextTabs, activeTabId: copy.tabId };
}

export function openBlankRequestTab(
  tabs: RequestTabSession[],
  _activeTabId: string,
  options?: {
    tabId?: string;
    forceNew?: boolean;
  },
): { tabs: RequestTabSession[]; activeTabId: string } {
  if (!options?.forceNew && tabs.length === 1 && isPristineBlankTab(tabs[0])) {
    return { tabs, activeTabId: tabs[0].tabId };
  }

  const nextTab = createBlankTabSession(options?.tabId);
  return { tabs: [...tabs, nextTab], activeTabId: nextTab.tabId };
}

export function openImportedSingleTab(
  tabs: RequestTabSession[],
  _activeTabId: string,
  item: CollectionRequestItem,
  options?: {
    collectionName?: string;
    tabId?: string;
  },
): { tabs: RequestTabSession[]; activeTabId: string } {
  const nextTab: RequestTabSession = {
    ...createTabFromCollectionItem(item, {
      collectionName: options?.collectionName,
      tabId: options?.tabId,
    }),
    requestId: null,
    importWarnings: [
      'Asersi tidak diimport: atur manual di tab Assertions.',
      ...item.warnings,
    ],
  };

  if (tabs.length === 1 && isPristineBlankTab(tabs[0])) {
    return { tabs: [nextTab], activeTabId: nextTab.tabId };
  }

  return { tabs: [...tabs, nextTab], activeTabId: nextTab.tabId };
}

export function closeRequestTab(
  tabs: RequestTabSession[],
  activeTabId: string,
  targetTabId: string,
  fallbackTabId?: string,
): { tabs: RequestTabSession[]; activeTabId: string } {
  const closedIndex = tabs.findIndex((t) => t.tabId === targetTabId);
  if (closedIndex < 0) {
    const validActive = tabs.some((t) => t.tabId === activeTabId)
      ? activeTabId
      : (tabs[0]?.tabId ?? '');
    return { tabs, activeTabId: validActive };
  }

  const remaining = tabs.filter((t) => t.tabId !== targetTabId);
  if (remaining.length === 0) {
    const fresh = createBlankTabSession(fallbackTabId);
    return { tabs: [fresh], activeTabId: fresh.tabId };
  }

  if (targetTabId === activeTabId) {
    const nextIdx = Math.min(closedIndex, remaining.length - 1);
    return { tabs: remaining, activeTabId: remaining[nextIdx].tabId };
  }

  const nextActive = remaining.some((t) => t.tabId === activeTabId)
    ? activeTabId
    : remaining[0].tabId;
  return { tabs: remaining, activeTabId: nextActive };
}

export function unlinkRemovedCollectionTabs(
  tabs: RequestTabSession[],
  removedItemIds: Set<string>,
): RequestTabSession[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.requestId && removedItemIds.has(tab.requestId)) {
      changed = true;
      return {
        ...tab,
        requestId: null,
        breadcrumb: 'Request Tunggal',
      };
    }
    return tab;
  });
  return changed ? next : tabs;
}

export function tabToDraftSnapshot(tab: RequestTabSession): RequestDraftSnapshot {
  return {
    method: tab.method,
    url: tab.url,
    queryParams: cloneDraftRows(tab.queryParams),
    headers: cloneDraftRows(tab.headers),
    bodyText: tab.bodyText,
    assertions: cloneAssertionDrafts(tab.assertions),
    importWarnings: [...tab.importWarnings],
    result: tab.result,
    errorResult: tab.errorResult,
  };
}
