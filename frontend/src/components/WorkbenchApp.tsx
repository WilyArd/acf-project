import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CollectionGroup,
  CollectionRequestItem,
  Environment,
  HistoryEntry,
  ThemeMode,
} from '../types/api';
import {
  INITIAL_ASSERTIONS,
  INITIAL_COLLECTIONS,
  INITIAL_ENVIRONMENTS,
} from '../lib/defaults';
import {
  appendHistoryEntry,
  clearHistory,
  loadHistory,
  loadInspectorPreference,
  saveInspectorPreference,
  THEME_STORAGE_KEY,
} from '../lib/history';
import {
  buildExecutePayload,
  collectRequestVariableRefs,
  extractAutoToken,
  lookupDotPath,
  normalizeUrlPathSlashes,
  substituteTemplate,
} from '../lib/variables';
import { executeProxyRequest } from '../lib/apiClient';
import {
  createInitialBatchResults,
  moveBatchItem,
  runSequentialBatch,
  toggleBatchFolderSelection,
  toggleBatchSelection,
  type BatchStepInput,
  type BatchStepResult,
} from '../lib/batchRunner';
import {
  clearWorkspaceDb,
  loadWorkspaceFromDb,
  saveWorkspaceToDb,
} from '../lib/sessionStorageDb';
import {
  applyPostResponseVarRulesToEnv,
  detectBareJwtAuthorizationHeader,
  mergeCollectionAndActiveEnv,
  upsertTokenIntoEnvironment,
} from '../lib/postResponseScripts';
import {
  cloneAssertionDrafts,
  cloneDraftRows,
  closeRequestTab,
  createBlankTabSession,
  duplicateRequestTab,
  openBlankRequestTab,
  openImportedSingleTab,
  openOrFocusCollectionTab,
  tabToDraftSnapshot,
  unlinkRemovedCollectionTabs,
  type RequestDraftSnapshot,
  type RequestTabSession,
} from '../lib/requestTabs';
import { nextUid } from '../lib/postmanImport';
import { TopBar } from './TopBar';
import { Sidebar, type SidebarTab } from './Sidebar';
import { RequestPanel } from './RequestPanel';
import { RequestTabBar } from './RequestTabBar';
import { ResponsePanel } from './ResponsePanel';
import { VariablesInspector } from './VariablesInspector';
import { EnvironmentEditor } from './EnvironmentEditor';
import { BatchRunnerPanel } from './BatchRunnerPanel';
import { BatchResultStrip } from './BatchResultStrip';
import { ConfirmDialog } from './ConfirmDialog';
import { ImportPostmanModal } from './ImportPostmanModal';

function resolveBaseOrigin(rawUrlTemplate: string, activeEnv: Environment | null): string {
  const sub = substituteTemplate(rawUrlTemplate.trim(), activeEnv, null);
  if (sub.unresolved.length > 0) return '';
  const normalized = normalizeUrlPathSlashes(sub.resolved);
  try {
    return new URL(normalized).origin;
  } catch {
    return '';
  }
}

export const WorkbenchApp: React.FC = () => {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [viewMode, setViewMode] = useState<'request' | 'env-editor' | 'batch-runner'>('request');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('collections');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => loadInspectorPreference());
  const [globalFilter, setGlobalFilter] = useState('');
  const [proxyStatus, setProxyStatus] = useState<'idle' | 'online' | 'offline'>('idle');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarFilterRef = useRef<HTMLInputElement | null>(null);

  // Per-request in-memory snapshot map (preserves edits & isolates results per endpoint)
  const draftsRef = useRef<Map<string, RequestDraftSnapshot>>(new Map());

  // Collections & Environments (client session memory only; never persisted to localStorage)
  const [collections, setCollections] = useState<CollectionGroup[]>(INITIAL_COLLECTIONS);
  const [environments, setEnvironments] = useState<Environment[]>(INITIAL_ENVIRONMENTS);
  const [activeEnvId, setActiveEnvId] = useState<string | null>(null);
  const [editingEnvId, setEditingEnvId] = useState<string | null>(null);

  // Active Request Tabs State (memory only; keeps independent drafts/responses per tab)
  const [openTabs, setOpenTabs] = useState<RequestTabSession[]>(() => [
    createBlankTabSession('tab-initial', INITIAL_ASSERTIONS),
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-initial');
  const openTabsRef = useRef<RequestTabSession[]>(openTabs);
  const activeTabIdRef = useRef<string>(activeTabId);

  const [elapsedMs, setElapsedMs] = useState(0);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const activeTab = useMemo(
    () => openTabs.find((t) => t.tabId === activeTabId) ?? openTabs[0],
    [openTabs, activeTabId],
  );

  const selectedRequestId = activeTab.requestId;
  const requestTitle = activeTab.title;
  const breadcrumb = activeTab.breadcrumb;
  const method = activeTab.method;
  const url = activeTab.url;
  const queryParams = activeTab.queryParams;
  const headers = activeTab.headers;
  const bodyText = activeTab.bodyText;
  const assertions = activeTab.assertions;
  const requestTab = activeTab.requestTab;
  const importWarnings = activeTab.importWarnings;
  const isLoading = activeTab.isLoading;
  const result = activeTab.result;
  const errorResult = activeTab.errorResult;
  const validationError = activeTab.validationError;
  const clientError = activeTab.clientError;
  const networkError = activeTab.networkError;
  const responseTab = activeTab.responseTab;

  const commitTabs = (next: { tabs: RequestTabSession[]; activeTabId: string }) => {
    openTabsRef.current = next.tabs;
    activeTabIdRef.current = next.activeTabId;
    setOpenTabs(next.tabs);
    setActiveTabId(next.activeTabId);
  };

  const updateTabById = (
    tabId: string,
    updater: (tab: RequestTabSession) => RequestTabSession,
  ) => {
    const nextTabs = openTabsRef.current.map((t) => (t.tabId === tabId ? updater(t) : t));
    openTabsRef.current = nextTabs;
    setOpenTabs(nextTabs);
  };

  const updateActiveTab = (updater: (tab: RequestTabSession) => RequestTabSession) => {
    updateTabById(activeTabIdRef.current, updater);
  };

  const syncOpenTabsToDrafts = () => {
    for (const tab of openTabsRef.current) {
      if (tab.requestId) {
        draftsRef.current.set(tab.requestId, tabToDraftSnapshot(tab));
      }
    }
  };

  // Token Passthrough State (memory only, origin & environment scoped)
  const [capturedToken, setCapturedToken] = useState<{
    path: string;
    value: string;
    origin: string;
  } | null>(null);
  const [tokenRevoked, setTokenRevoked] = useState(false);
  const lastResultOriginRef = useRef<string>('');

  // History State (strict whitelist persisted in localStorage['acf-history'])
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Import & Confirmation Modal State
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [clearCacheConfirmOpen, setClearCacheConfirmOpen] = useState(false);

  // Sequential Multi-Request Runner State (memory only)
  const [batchSelectMode, setBatchSelectMode] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [batchStopOnFailure, setBatchStopOnFailure] = useState(false);
  const [batchDelayMs, setBatchDelayMs] = useState(0);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchStepResult[] | null>(null);
  const [batchMeta, setBatchMeta] = useState<{ rateLimited: boolean; aborted: boolean }>({
    rateLimited: false,
    aborted: false,
  });
  const batchAbortRef = useRef<AbortController | null>(null);
  const [pendingInspectId, setPendingInspectId] = useState<string | null>(null);
  const dbHydratedRef = useRef(false);

  // Initialize theme, whitelist history, and sanitized IndexedDB workspace on mount
  useEffect(() => {
    try {
      const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme === 'light' || savedTheme === 'dark') {
        setTheme(savedTheme);
        document.documentElement.setAttribute('data-theme', savedTheme);
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    } catch {
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    setHistory(loadHistory());

    if (window.innerWidth < 1280) {
      setInspectorOpen(false);
    }

    let mounted = true;    void loadWorkspaceFromDb().then((snapshot) => {
      if (!mounted) return;
      if (snapshot) {
        if (snapshot.collections.length > 0) setCollections(snapshot.collections);
        if (snapshot.environments.length > 0) setEnvironments(snapshot.environments);
        if (snapshot.activeEnvId) setActiveEnvId(snapshot.activeEnvId);
      }
      dbHydratedRef.current = true;
    });

    return () => {
      mounted = false;
    };
  }, []);

  // Persist sanitized collections & non-secret environments to browser IndexedDB
  useEffect(() => {
    if (!dbHydratedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveWorkspaceToDb({ collections, environments, activeEnvId });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [collections, environments, activeEnvId]);

  const handleToggleTheme = (next: ThemeMode) => {
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors
    }
  };

  const handleToggleInspector = () => {
    setInspectorOpen((open) => {
      const next = !open;
      saveInspectorPreference(next);
      return next;
    });
  };

  const closeInspector = () => {
    setInspectorOpen(false);
    saveInspectorPreference(false);
  };

  // Loading elapsed timer tracked per active tab
  useEffect(() => {
    if (!activeTab.isLoading || !activeTab.loadingStartedAt) {
      setElapsedMs(0);
      return;
    }
    const startedAt = activeTab.loadingStartedAt;
    setElapsedMs(Date.now() - startedAt);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 100);
    return () => window.clearInterval(id);
  }, [activeTab.tabId, activeTab.isLoading, activeTab.loadingStartedAt]);

  const [autoSyncEnvToken, setAutoSyncEnvToken] = useState(true);
  const autoSyncEnvTokenRef = useRef(autoSyncEnvToken);
  autoSyncEnvTokenRef.current = autoSyncEnvToken;
  const environmentsRef = useRef(environments);
  environmentsRef.current = environments;
  const activeEnvIdRef = useRef(activeEnvId);
  activeEnvIdRef.current = activeEnvId;

  const activeEnv = useMemo(
    () => environments.find((e) => e.id === activeEnvId) ?? null,
    [environments, activeEnvId],
  );

  const activeCollection = useMemo(
    () =>
      selectedRequestId
        ? collections.find((c) => c.items.some((item) => item.id === selectedRequestId)) ?? null
        : null,
    [collections, selectedRequestId],
  );

  const activeCollectionEnv = useMemo(() => {
    if (!activeCollection) return null;
    return environments.find((e) => e.name === `${activeCollection.name} (Vars)`) ?? null;
  }, [activeCollection, environments]);

  const mergedEnvInfo = useMemo(
    () => mergeCollectionAndActiveEnv(activeEnv, activeCollectionEnv),
    [activeEnv, activeCollectionEnv],
  );

  const effectiveEnv = mergedEnvInfo.effectiveEnv;

  const envTokenNeedsBearer = useMemo(() => {
    const checkHeaderList = (rows: typeof headers) => {
      for (const h of rows) {
        if (!h.enabled || h.key.trim().toLowerCase() !== 'authorization') continue;
        const val = h.value.trim();
        if (/^bearer\s+/i.test(val)) return false;
        if (/^\{\{\s*[^.{}\s]+\s*\}\}$/.test(val)) return true;
      }
      return null;
    };

    const currentCheck = checkHeaderList(headers);
    if (currentCheck !== null) return currentCheck;

    const searchCollections = activeCollection ? [activeCollection] : collections;
    for (const col of searchCollections) {
      for (const item of col.items) {
        const res = checkHeaderList(item.headers);
        if (res !== null) return res;
      }
    }
    return false;
  }, [headers, activeCollection, collections]);

  const editingEnv = useMemo(
    () => environments.find((e) => e.id === editingEnvId) ?? activeEnv ?? environments[0] ?? null,
    [environments, editingEnvId, activeEnv],
  );

  const lastResponseBody = result?.rawResponse.body ?? null;

  const currentTargetOrigin = useMemo(
    () => resolveBaseOrigin(url, effectiveEnv),
    [url, effectiveEnv],
  );

  // Isolate captured session tokens by origin to prevent cross-domain credential bleed.
  const effectiveCapturedToken = useMemo(() => {
    if (!capturedToken) return null;
    if (capturedToken.origin && currentTargetOrigin && capturedToken.origin !== currentTargetOrigin) {
      return null;
    }
    return capturedToken;
  }, [capturedToken, currentTargetOrigin]);

  const allowResponseFallback =
    !tokenRevoked &&
    (!capturedToken?.origin || !currentTargetOrigin || capturedToken.origin === currentTargetOrigin);

  const bareJwtIssue = useMemo(
    () =>
      detectBareJwtAuthorizationHeader(
        headers,
        effectiveEnv,
        lastResponseBody,
        effectiveCapturedToken,
        allowResponseFallback,
      ),
    [headers, effectiveEnv, lastResponseBody, effectiveCapturedToken, allowResponseFallback],
  );

  const varTracking = useMemo(
    () =>
      collectRequestVariableRefs({
        url,
        queryParams,
        headers,
        bodyText,
        assertions,
        method,
        activeEnv: effectiveEnv,
        lastResponseBody,
        manualPassthroughToken: effectiveCapturedToken,
        allowResponseFallback,
      }),
    [
      url,
      queryParams,
      headers,
      bodyText,
      assertions,
      method,
      effectiveEnv,
      lastResponseBody,
      effectiveCapturedToken,
      allowResponseFallback,
    ],
  );

  const saveCurrentDraft = () => {
    syncOpenTabsToDrafts();
  };

  const handleSelectRequest = (
    item: CollectionRequestItem,
    overrideCollectionName?: string,
    forceDuplicate = false,
  ) => {
    syncOpenTabsToDrafts();

    const parentCol = collections.find((c) => c.items.some((i) => i.id === item.id));
    const colName = overrideCollectionName ?? parentCol?.name;
    const saved = draftsRef.current.get(item.id) ?? null;

    setViewMode('request');
    commitTabs(
      openOrFocusCollectionTab(openTabsRef.current, activeTabIdRef.current, item, {
        collectionName: colName,
        draft: saved,
        forceDuplicate,
      }),
    );
  };

  const handleDuplicateTab = (targetTabId: string) => {
    syncOpenTabsToDrafts();
    setViewMode('request');
    commitTabs(duplicateRequestTab(openTabsRef.current, targetTabId));
  };

  const handleSelectTab = (tabId: string) => {
    if (!openTabsRef.current.some((t) => t.tabId === tabId)) return;
    setViewMode('request');
    activeTabIdRef.current = tabId;
    setActiveTabId(tabId);
  };

  const handleCloseTab = (targetTabId: string) => {
    const closingTab = openTabsRef.current.find((t) => t.tabId === targetTabId);
    if (closingTab?.requestId) {
      draftsRef.current.set(closingTab.requestId, tabToDraftSnapshot(closingTab));
    }
    abortControllersRef.current.get(targetTabId)?.abort();
    abortControllersRef.current.delete(targetTabId);

    commitTabs(closeRequestTab(openTabsRef.current, activeTabIdRef.current, targetTabId));
  };

  const handleDeleteCollection = (collectionId: string) => {
    const col = collections.find((c) => c.id === collectionId);
    if (col) {
      const removedIds = new Set(col.items.map((item) => item.id));
      for (const item of col.items) {
        draftsRef.current.delete(item.id);
      }
      setBatchSelectedIds((prev) => prev.filter((id) => !removedIds.has(id)));
      setBatchResults(null);
      const unlinked = unlinkRemovedCollectionTabs(openTabsRef.current, removedIds);
      if (unlinked !== openTabsRef.current) {
        openTabsRef.current = unlinked;
        setOpenTabs(unlinked);
      }
    }
    setCollections((prev) => prev.filter((c) => c.id !== collectionId));
  };

  const buildBatchStepInputs = (ids: string[]): BatchStepInput[] => {
    const itemLookup = new Map<string, { item: CollectionRequestItem; collectionName: string }>();
    for (const col of collections) {
      for (const item of col.items) {
        itemLookup.set(item.id, { item, collectionName: col.name });
      }
    }

    const inputs: BatchStepInput[] = [];
    for (const id of ids) {
      const found = itemLookup.get(id);
      if (!found) continue;
      const savedDraft = draftsRef.current.get(id);
      inputs.push({
        item: found.item,
        collectionName: found.collectionName,
        ...(savedDraft
          ? {
              draft: {
                method: savedDraft.method,
                url: savedDraft.url,
                queryParams: cloneDraftRows(savedDraft.queryParams),
                headers: cloneDraftRows(savedDraft.headers),
                bodyText: savedDraft.bodyText,
                assertions: cloneAssertionDrafts(savedDraft.assertions),
              },
            }
          : {}),
      });
    }
    return inputs;
  };

  const displayedBatchSteps = useMemo(() => {
    if (batchResults && batchResults.length === batchSelectedIds.length) {
      const sameOrder = batchResults.every((step, idx) => step.itemId === batchSelectedIds[idx]);
      if (sameOrder) return batchResults;
    }
    return createInitialBatchResults(buildBatchStepInputs(batchSelectedIds));
  }, [batchResults, batchSelectedIds, collections]);

  const handleToggleBatchItem = (itemId: string) => {
    if (isBatchRunning) return;
    setBatchSelectedIds((prev) => toggleBatchSelection(prev, itemId));
    setBatchResults(null);
    setBatchMeta({ rateLimited: false, aborted: false });
  };

  const handleToggleBatchFolder = (itemIds: string[]) => {
    if (isBatchRunning) return;
    setBatchSelectedIds((prev) => toggleBatchFolderSelection(prev, itemIds));
    setBatchResults(null);
    setBatchMeta({ rateLimited: false, aborted: false });
  };

  const handleMoveBatchStep = (index: number, delta: -1 | 1) => {
    if (isBatchRunning) return;
    setBatchSelectedIds((prev) => moveBatchItem(prev, index, delta));
    setBatchResults(null);
    setBatchMeta({ rateLimited: false, aborted: false });
  };

  const handleRemoveBatchStep = (itemId: string) => {
    if (isBatchRunning) return;
    setBatchSelectedIds((prev) => prev.filter((id) => id !== itemId));
    setBatchResults(null);
    setBatchMeta({ rateLimited: false, aborted: false });
  };

  const handleClearBatchSelection = () => {
    if (isBatchRunning) return;
    setBatchSelectedIds([]);
    setBatchResults(null);
    setBatchMeta({ rateLimited: false, aborted: false });
  };

  const handleToggleBatchSelectMode = () => {
    if (isBatchRunning) return;
    if (batchSelectMode || batchSelectedIds.length > 0) {
      setBatchSelectMode(false);
      setBatchSelectedIds([]);
      setBatchResults(null);
      setBatchMeta({ rateLimited: false, aborted: false });
    } else {
      setBatchSelectMode(true);
      setSidebarTab('collections');
    }
  };

  const handleOpenBatchRunner = () => {
    if (viewMode === 'request') {
      saveCurrentDraft();
    }
    setViewMode('batch-runner');
  };

  const handleCancelBatchRun = () => {
    batchAbortRef.current?.abort();
  };

  const handleRunBatch = async () => {
    if (isBatchRunning || batchSelectedIds.length === 0) return;
    if (viewMode === 'request') {
      saveCurrentDraft();
    }

    const stepInputs = buildBatchStepInputs(batchSelectedIds);
    if (stepInputs.length === 0) return;

    batchAbortRef.current?.abort();
    const controller = new AbortController();
    batchAbortRef.current = controller;

    setIsBatchRunning(true);
    setBatchMeta({ rateLimited: false, aborted: false });
    setBatchResults(createInitialBatchResults(stepInputs));

    const summary = await runSequentialBatch({
      steps: stepInputs,
      activeEnv: effectiveEnv,
      autoSyncEnvToken: autoSyncEnvTokenRef.current,
      envTokenNeedsBearer,
      initialCapturedToken: capturedToken,
      initialLastResponseBody: lastResponseBody,
      initialLastResponseOrigin: lastResultOriginRef.current,
      allowResponseFallback: !tokenRevoked,
      stopOnFailure: batchStopOnFailure,
      delayMs: batchDelayMs,
      signal: controller.signal,
      onStepUpdate: (idx, stepResult) => {
        setBatchResults((prev) => {
          const base = prev ? [...prev] : createInitialBatchResults(stepInputs);
          base[idx] = stepResult;
          return base;
        });

        // Save result back into per-request draft so user can click "Detail" to inspect it
        if (stepResult.result || stepResult.errorResult) {
          setProxyStatus('online');
          const stepInput = stepInputs[idx];
          if (stepInput) {
            const existing = draftsRef.current.get(stepResult.itemId);
            draftsRef.current.set(stepResult.itemId, {
              method: existing?.method ?? stepInput.item.method,
              url: existing?.url ?? stepInput.item.url,
              queryParams: existing?.queryParams ?? cloneDraftRows(stepInput.item.queryParams),
              headers: existing?.headers ?? cloneDraftRows(stepInput.item.headers),
              bodyText: existing?.bodyText ?? stepInput.item.bodyText,
              assertions: existing?.assertions ?? cloneAssertionDrafts(INITIAL_ASSERTIONS),
              importWarnings: existing?.importWarnings ?? [...stepInput.item.warnings],
              result: stepResult.result ?? null,
              errorResult: stepResult.errorResult ?? null,
            });
          }

          const hasOpenTabForStep = openTabsRef.current.some(
            (t) => t.requestId === stepResult.itemId,
          );
          if (hasOpenTabForStep) {
            const nextTabs = openTabsRef.current.map((t) =>
              t.requestId === stepResult.itemId
                ? {
                    ...t,
                    result: stepResult.result ?? null,
                    errorResult: stepResult.errorResult ?? null,
                    validationError: null,
                    clientError: null,
                    networkError: null,
                  }
                : t,
            );
            openTabsRef.current = nextTabs;
            setOpenTabs(nextTabs);
          }

          if (stepResult.resolvedHistoryUrl) {
            const nextHist = appendHistoryEntry({
              method: stepResult.method,
              url: stepResult.resolvedHistoryUrl,
              timestamp:
                stepResult.result?.executedAt ??
                stepResult.errorResult?.executedAt ??
                new Date().toISOString(),
              overallStatus: stepResult.result ? stepResult.result.overallStatus : 'ERROR',
              passedCount: stepResult.result?.passedCount ?? 0,
              failedCount: stepResult.result?.failedCount ?? 0,
            });
            setHistory(nextHist);
          }
        } else if (stepResult.networkError) {
          setProxyStatus('offline');
        }
      },
    });

    if (summary.updatedActiveEnv) {
      const updatedEnv = summary.updatedActiveEnv;
      setEnvironments((prev) =>
        prev.map((env) => {
          if (env.id !== updatedEnv.id) return env;
          // Preserve existing variable order and update values cleanly
          const mergedMap = new Map(updatedEnv.variables.map((v) => [v.key.trim(), v]));
          const nextVars = env.variables.map((v) => {
            const match = mergedMap.get(v.key.trim());
            if (!match) return v;
            mergedMap.delete(v.key.trim());
            return { ...v, enabled: match.enabled, currentValue: match.currentValue };
          });
          for (const added of mergedMap.values()) {
            // Only append variables created by explicit postResponseVars (tagged envv_sync_), not inherited collection vars
            if (added.id.startsWith('envv_sync_')) {
              nextVars.push(added);
            }
          }
          return { ...env, variables: nextVars };
        }),
      );
    }

    if (summary.finalCapturedToken) {
      setTokenRevoked(false);
      setCapturedToken(summary.finalCapturedToken);
      lastResultOriginRef.current = summary.finalCapturedToken.origin;
    }

    setBatchResults(summary.steps);
    setBatchMeta({ rateLimited: summary.rateLimited, aborted: summary.aborted });
    setIsBatchRunning(false);

    const focusStep =
      summary.steps.find(
        (s) => s.status === 'fail' || s.status === 'error' || s.status === 'validation',
      ) ?? [...summary.steps].reverse().find((s) => s.result || s.errorResult);
    if (focusStep) setPendingInspectId(focusStep.itemId);
  };

  const handleInspectBatchStep = (itemId: string) => {
    for (const col of collections) {
      const found = col.items.find((it) => it.id === itemId);
      if (found) {
        handleSelectRequest(found, col.name);
        return;
      }
    }
  };

  // Focus the first failing (or last) Multi-Run step after the batch finishes, using fresh state.
  useEffect(() => {
    if (!pendingInspectId) return;
    const id = pendingInspectId;
    setPendingInspectId(null);
    handleInspectBatchStep(id);
  }, [pendingInspectId]);

  const handleClearLocalCache = () => {
    setClearCacheConfirmOpen(true);
  };

  const confirmClearLocalCache = () => {
    setClearCacheConfirmOpen(false);
    void clearWorkspaceDb();
    draftsRef.current.clear();
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    setCollections([]);
    setEnvironments([]);
    setActiveEnvId(null);
    setEditingEnvId(null);
    const freshTab = createBlankTabSession(undefined, INITIAL_ASSERTIONS);
    commitTabs({ tabs: [freshTab], activeTabId: freshTab.tabId });
    setBatchSelectedIds([]);
    setBatchResults(null);
    setCapturedToken(null);
    setTokenRevoked(true);
    setViewMode('request');
  };

  const handleNewBlankRequest = (forceNew = false) => {
    syncOpenTabsToDrafts();
    setViewMode('request');
    commitTabs(
      openBlankRequestTab(openTabsRef.current, activeTabIdRef.current, {
        forceNew,
      }),
    );
    if (typeof document !== 'undefined') {
      window.setTimeout(() => {
        document.getElementById('request-url-input')?.focus();
      }, 0);
    }
  };

  const handleCreateEnv = (initialVarKey?: string) => {
    const newEnv: Environment = {
      id: nextUid('env'),
      name: `Environment ${environments.length + 1}`,
      variables: [
        {
          id: nextUid('envv'),
          enabled: true,
          key: initialVarKey || 'url',
          type: 'default',
          initialValue: '',
          currentValue: '',
        },
      ],
    };
    setEnvironments((prev) => [...prev, newEnv]);
    setActiveEnvId(newEnv.id);
    setEditingEnvId(newEnv.id);
    setSidebarTab('envs');
    setViewMode('env-editor');
  };

  const handleQuickAddVariable = (varName: string) => {
    if (!activeEnv) {
      handleCreateEnv(varName);
      return;
    }
    const alreadyExists = activeEnv.variables.some((v) => v.key.trim() === varName);
    if (!alreadyExists) {
      const updated: Environment = {
        ...activeEnv,
        variables: [
          ...activeEnv.variables,
          {
            id: nextUid('envv'),
            enabled: true,
            key: varName,
            type: 'default',
            initialValue: '',
            currentValue: '',
          },
        ],
      };
      setEnvironments((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    }
    setEditingEnvId(activeEnv.id);
    setSidebarTab('envs');
    setViewMode('env-editor');
  };

  const handleQuickUpdateVariable = (
    varKey: string,
    nextValue: string,
    scope: 'environment' | 'collection' = 'environment',
  ) => {
    const cleanKey = varKey.trim();
    if (!cleanKey) return;
    const targetEnv =
      scope === 'collection' && activeCollectionEnv
        ? activeCollectionEnv
        : (activeEnv ?? activeCollectionEnv ?? environments[0] ?? null);
    if (!targetEnv) return;

    setEnvironments((prev) =>
      prev.map((env) => {
        if (env.id !== targetEnv.id) return env;
        const idx = env.variables.findIndex((v) => v.key.trim() === cleanKey);
        if (idx < 0) return env;
        const existing = env.variables[idx]!;
        const shouldSyncInitial =
          existing.type === 'default' &&
          (existing.initialValue === '' || existing.initialValue === existing.currentValue);
        const updatedVar = {
          ...existing,
          enabled: true,
          currentValue: nextValue,
          ...(shouldSyncInitial ? { initialValue: nextValue } : {}),
        };
        return {
          ...env,
          variables: env.variables.map((v, i) => (i === idx ? updatedVar : v)),
        };
      }),
    );
  };

  const handleEditEnv = (envId: string) => {
    setEditingEnvId(envId);
    setViewMode('env-editor');
  };

  const handleUpdateEnv = (updated: Environment) => {
    setEnvironments((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
  };

  const handleDuplicateEnv = (env: Environment) => {
    const copy: Environment = {
      id: nextUid('env'),
      name: `${env.name} (Salinan)`,
      variables: env.variables.map((v) => ({
        ...v,
        id: nextUid('envv'),
        currentValue: v.type === 'secret' ? '' : v.currentValue,
      })),
    };
    setEnvironments((prev) => [...prev, copy]);
    setEditingEnvId(copy.id);
  };

  const selectActiveEnv = (nextEnvId: string | null) => {
    setActiveEnvId((prev) => {
      if (prev !== nextEnvId) {
        setCapturedToken(null);
        setTokenRevoked(true);
      }
      return nextEnvId;
    });
    updateActiveTab((t) => ({ ...t, clientError: null }));
  };

  const handleDeleteEnv = (envId: string) => {
    if (activeEnvId === envId) {
      selectActiveEnv(null);
    }
    setEnvironments((prev) => {
      const remaining = prev.filter((e) => e.id !== envId);
      if (editingEnvId === envId) setEditingEnvId(remaining[0]?.id ?? null);
      if (remaining.length === 0) setViewMode('request');
      return remaining;
    });
  };

  const handleExecute = async () => {
    const targetTab =
      openTabsRef.current.find((t) => t.tabId === activeTabIdRef.current) ?? activeTab;
    const targetTabId = targetTab.tabId;
    if (targetTab.isLoading) return;

    const targetCol = targetTab.requestId
      ? collections.find((c) => c.items.some((i) => i.id === targetTab.requestId)) ?? null
      : null;
    const targetColItem = targetCol?.items.find((i) => i.id === targetTab.requestId) ?? null;
    const currentActiveEnv =
      environmentsRef.current.find((e) => e.id === activeEnvIdRef.current) ?? null;
    const targetColEnv = targetCol
      ? environmentsRef.current.find((e) => e.name === `${targetCol.name} (Vars)`) ?? null
      : null;
    const targetEffectiveEnv = mergeCollectionAndActiveEnv(
      currentActiveEnv,
      targetColEnv,
    ).effectiveEnv;

    const targetOrigin = resolveBaseOrigin(targetTab.url, targetEffectiveEnv);
    const targetCapturedToken =
      capturedToken &&
      (!capturedToken.origin || !targetOrigin || capturedToken.origin === targetOrigin)
        ? capturedToken
        : null;
    const targetAllowFallback =
      !tokenRevoked &&
      (!capturedToken?.origin || !targetOrigin || capturedToken.origin === targetOrigin);
    const targetLastBody = targetTab.result?.rawResponse.body ?? null;

    updateTabById(targetTabId, (t) => ({
      ...t,
      clientError: null,
      validationError: null,
      networkError: null,
    }));

    const built = buildExecutePayload({
      method: targetTab.method,
      url: targetTab.url,
      queryParams: targetTab.queryParams,
      headers: targetTab.headers,
      bodyText: targetTab.bodyText,
      assertions: targetTab.assertions,
      activeEnv: targetEffectiveEnv,
      lastResponseBody: targetLastBody,
      manualPassthroughToken: targetCapturedToken,
      allowResponseFallback: targetAllowFallback,
    });

    if (!built.ok) {
      updateTabById(targetTabId, (t) => ({
        ...t,
        clientError: built.error,
        requestTab: built.error.toLowerCase().includes('assertion')
          ? 'assertions'
          : built.error.includes('JSON')
            ? 'body'
            : t.requestTab,
      }));
      return;
    }

    let executedOrigin = '';
    try {
      executedOrigin = new URL(built.payload.request.url).origin;
    } catch {
      executedOrigin = '';
    }

    abortControllersRef.current.get(targetTabId)?.abort();
    const controller = new AbortController();
    abortControllersRef.current.set(targetTabId, controller);

    updateTabById(targetTabId, (t) => ({
      ...t,
      isLoading: true,
      loadingStartedAt: Date.now(),
      result: null,
      errorResult: null,
    }));

    const outcome = await executeProxyRequest(built.payload, controller.signal);
    if (abortControllersRef.current.get(targetTabId) === controller) {
      abortControllersRef.current.delete(targetTabId);
    }

    if (outcome.kind === 'aborted') {
      updateTabById(targetTabId, (t) => ({
        ...t,
        isLoading: false,
        loadingStartedAt: null,
      }));
      return;
    }

    if (outcome.kind === 'network') {
      setProxyStatus('offline');
      updateTabById(targetTabId, (t) => ({
        ...t,
        isLoading: false,
        loadingStartedAt: null,
        networkError: outcome.message,
      }));
      return;
    }

    setProxyStatus('online');

    if (outcome.kind === 'validation') {
      // Do NOT write pre-flight 400/403/429 rejections to history (design.md §6)
      updateTabById(targetTabId, (t) => ({
        ...t,
        isLoading: false,
        loadingStartedAt: null,
        validationError: outcome.error,
      }));
      return;
    }

    if (outcome.kind === 'error') {
      updateTabById(targetTabId, (t) => {
        const nextTab: RequestTabSession = {
          ...t,
          isLoading: false,
          loadingStartedAt: null,
          errorResult: outcome.data,
        };
        if (nextTab.requestId) {
          draftsRef.current.set(nextTab.requestId, tabToDraftSnapshot(nextTab));
        }
        return nextTab;
      });
      const nextHist = appendHistoryEntry({
        method: built.payload.request.method,
        url: built.resolvedFullUrl,
        timestamp: outcome.data.executedAt,
        overallStatus: 'ERROR',
        passedCount: 0,
        failedCount: 0,
      });
      setHistory(nextHist);
      return;
    }

    // PASS or FAIL
    lastResultOriginRef.current = executedOrigin;
    setTokenRevoked(false);
    updateTabById(targetTabId, (t) => {
      const nextTab: RequestTabSession = {
        ...t,
        isLoading: false,
        loadingStartedAt: null,
        result: outcome.data,
        responseTab: 'assertions',
      };
      if (nextTab.requestId) {
        draftsRef.current.set(nextTab.requestId, tabToDraftSnapshot(nextTab));
      }
      return nextTab;
    });

    if (outcome.data.rawResponse.statusCode >= 200 && outcome.data.rawResponse.statusCode < 300) {
      const autoToken = extractAutoToken(outcome.data.rawResponse.body);
      if (autoToken) {
        setCapturedToken({ ...autoToken, origin: executedOrigin });
      }

      const rules = targetColItem?.postResponseVars ?? [];
      if (rules.length > 0) {
        const envRules = rules.filter((r) => r.target === 'environment');
        const colRules = rules.filter((r) => r.target === 'collection');
        const destEnvId = activeEnvIdRef.current ?? targetColEnv?.id ?? null;

        if (envRules.length > 0 && destEnvId) {
          setEnvironments((prev) =>
            prev.map((env) =>
              env.id === destEnvId
                ? applyPostResponseVarRulesToEnv(
                    env,
                    envRules,
                    outcome.data.rawResponse.body,
                    outcome.data.rawResponse.statusCode,
                  ).updatedEnv
                : env,
            ),
          );
        }
        if (colRules.length > 0 && targetColEnv) {
          setEnvironments((prev) =>
            prev.map((env) =>
              env.id === targetColEnv.id
                ? applyPostResponseVarRulesToEnv(
                    env,
                    colRules,
                    outcome.data.rawResponse.body,
                    outcome.data.rawResponse.statusCode,
                  ).updatedEnv
                : env,
            ),
          );
        }
      } else if (autoSyncEnvTokenRef.current && autoToken) {
        const currentEnv =
          environmentsRef.current.find((e) => e.id === activeEnvIdRef.current) ?? targetColEnv;
        const hasExistingTokenVar = currentEnv?.variables.some((v) =>
          ['token', 'access_token', 'jwt', 'auth_token', 'bearer_token'].includes(
            v.key.trim().toLowerCase(),
          ),
        );
        if (currentEnv && hasExistingTokenVar) {
          setEnvironments((prev) =>
            prev.map((env) =>
              env.id === currentEnv.id
                ? upsertTokenIntoEnvironment(env, autoToken.value, {
                    withBearerPrefix: envTokenNeedsBearer,
                  }).updatedEnv
                : env,
            ),
          );
        }
      }
    }

    const nextHist = appendHistoryEntry({
      method: built.payload.request.method,
      url: built.resolvedFullUrl,
      timestamp: outcome.data.executedAt,
      overallStatus: outcome.data.overallStatus,
      passedCount: outcome.data.passedCount,
      failedCount: outcome.data.failedCount,
    });
    setHistory(nextHist);
  };

  const handleExecuteAction = async () => {
    if (batchSelectMode || batchSelectedIds.length > 0) {
      if (batchSelectedIds.length === 0) return;
      if (viewMode === 'request') {
        saveCurrentDraft();
      }
      await handleRunBatch();
      return;
    }
    await handleExecute();
  };

  // Global keyboard shortcuts: Ctrl+K search (with sidebar fallback), Ctrl+Enter execute, Escape closes mobile drawer
  const handleExecuteRef = useRef(handleExecuteAction);
  handleExecuteRef.current = handleExecuteAction;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (searchInputRef.current && searchInputRef.current.offsetParent !== null) {
          searchInputRef.current.focus();
        } else if (sidebarFilterRef.current && sidebarFilterRef.current.offsetParent !== null) {
          sidebarFilterRef.current.focus();
        } else {
          setMobileMenuOpen(true);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && viewMode === 'request' && !importModalOpen && !clearCacheConfirmOpen) {
        e.preventDefault();
        void handleExecuteRef.current();
      }
      if (e.key === 'Escape' && mobileMenuOpen) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileMenuOpen, viewMode, importModalOpen, clearCacheConfirmOpen]);

  const handleCancelExecute = () => {
    const tabId = activeTabIdRef.current;
    abortControllersRef.current.get(tabId)?.abort();
    abortControllersRef.current.delete(tabId);
    updateTabById(tabId, (t) => ({
      ...t,
      isLoading: false,
      loadingStartedAt: null,
    }));
  };

  const handleInsertBearerHeader = (dotPath: string) => {
    const tokenTemplate = `Bearer {{$.${dotPath}}}`;
    updateActiveTab((t) => {
      const idx = t.headers.findIndex((h) => h.key.trim().toLowerCase() === 'authorization');
      const nextHeaders =
        idx >= 0
          ? t.headers.map((h, i) =>
              i === idx ? { ...h, enabled: true, key: 'Authorization', value: tokenTemplate } : h,
            )
          : [
              ...t.headers,
              {
                id: nextUid('hdr'),
                enabled: true,
                key: 'Authorization',
                value: tokenTemplate,
                description: 'Token passthrough sesi',
              },
            ];
      return {
        ...t,
        headers: nextHeaders,
        requestTab: 'headers',
      };
    });
  };

  const handleFixBareJwtHeader = () => {
    if (!bareJwtIssue) return;
    const issue = bareJwtIssue;
    updateActiveTab((t) => ({
      ...t,
      headers: t.headers.map((h) =>
        h.id === issue.headerId ? { ...h, value: issue.suggestedTemplate } : h,
      ),
      requestTab: 'headers',
    }));
  };

  const handleSaveTokenToEnv = (dotPath: string, withBearerPrefix: boolean): string | null => {
    const cleanPath = dotPath.trim().replace(/^\$\./, '');
    const lookup = lookupDotPath(result?.rawResponse.body, cleanPath);
    const tokenVal =
      lookup.found && lookup.value !== null && lookup.value !== undefined && typeof lookup.value !== 'object'
        ? String(lookup.value)
        : capturedToken?.path === cleanPath
          ? capturedToken.value
          : '';
    if (!tokenVal) return null;

    const targetEnv = activeEnv ?? environments[0] ?? null;
    if (!targetEnv) {
      const created = upsertTokenIntoEnvironment(
        { id: nextUid('env'), name: 'Session Environment', variables: [] },
        tokenVal,
        { withBearerPrefix },
      );
      setEnvironments((prev) => [...prev, created.updatedEnv]);
      setActiveEnvId(created.updatedEnv.id);
      return created.varName;
    }

    const res = upsertTokenIntoEnvironment(targetEnv, tokenVal, { withBearerPrefix });
    setEnvironments((prev) => prev.map((e) => (e.id === targetEnv.id ? res.updatedEnv : e)));
    if (activeEnvId !== targetEnv.id) {
      setActiveEnvId(targetEnv.id);
    }
    return res.varName;
  };

  return (
    <div
      className="flex min-h-dvh w-full min-w-0 flex-col lg:h-dvh lg:overflow-hidden"
      style={{
        backgroundColor: 'var(--surface-canvas)',
        color: 'var(--text-primary)',
      }}
    >
      <a href="#main-workbench" className="skip-link">
        Langsung ke area pengujian utama
      </a>

      <TopBar
        theme={theme}
        onToggleTheme={handleToggleTheme}
        environments={environments}
        activeEnvId={activeEnvId}
        onSelectEnv={selectActiveEnv}
        onCreateEnv={() => handleCreateEnv()}
        onOpenImport={() => setImportModalOpen(true)}
        inspectorOpen={inspectorOpen}
        onToggleInspector={handleToggleInspector}
        unresolvedCount={varTracking.unresolved.length}
        searchQuery={globalFilter}
        onSearchChange={setGlobalFilter}
        searchInputRef={searchInputRef}
        mobileMenuOpen={mobileMenuOpen}
        onToggleMobileMenu={() => setMobileMenuOpen((o) => !o)}
      />

      {/* Responsive 3-Pane App Shell */}
      <div className="relative flex min-h-0 w-full min-w-0 flex-1 lg:overflow-hidden">
        {/* Desktop Persistent Sidebar (>= lg) */}
        <div className="hidden h-full min-h-0 w-68 shrink-0 lg:flex lg:flex-col">
          <Sidebar
            activeTab={sidebarTab}
            onTabChange={setSidebarTab}
            collections={collections}
            selectedRequestId={selectedRequestId}
            onSelectRequest={(item, opts) => handleSelectRequest(item, undefined, opts?.forceDuplicate)}
            onDeleteCollection={handleDeleteCollection}
            onNewBlankRequest={() => handleNewBlankRequest(true)}
            batchSelectMode={batchSelectMode}
            batchSelectedIds={batchSelectedIds}
            onToggleBatchItem={handleToggleBatchItem}
            onToggleBatchFolder={handleToggleBatchFolder}
            onClearBatchSelection={handleClearBatchSelection}
            isBatchRunning={isBatchRunning}
            onClearLocalCache={handleClearLocalCache}
            environments={environments}
            activeEnvId={activeEnvId}
            editingEnvId={viewMode === 'env-editor' ? editingEnv?.id ?? null : null}
            onSelectActiveEnv={selectActiveEnv}
            onEditEnv={handleEditEnv}
            onCreateEnv={() => handleCreateEnv()}
            onDeleteEnv={handleDeleteEnv}
            history={history}
            onClearHistory={() => {
              clearHistory();
              setHistory([]);
            }}
            globalFilter={globalFilter}
            onOpenImport={() => setImportModalOpen(true)}
            proxyStatus={proxyStatus}
            filterInputRef={sidebarFilterRef}
          />
        </div>

        {/* Mobile / Tablet Slide-Over Sidebar Drawer (< lg) */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-40 flex lg:hidden"
            style={{ backgroundColor: 'var(--scrim)' }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setMobileMenuOpen(false);
            }}
          >
            <div className="h-full w-72 max-w-[85vw]">
              <Sidebar
                activeTab={sidebarTab}
                onTabChange={setSidebarTab}
                collections={collections}
                selectedRequestId={selectedRequestId}
                onSelectRequest={(item, opts) => handleSelectRequest(item, undefined, opts?.forceDuplicate)}
                onDeleteCollection={handleDeleteCollection}
                onNewBlankRequest={() => handleNewBlankRequest(true)}
                batchSelectMode={batchSelectMode}
                batchSelectedIds={batchSelectedIds}
                onToggleBatchItem={handleToggleBatchItem}
                onToggleBatchFolder={handleToggleBatchFolder}
                onClearBatchSelection={handleClearBatchSelection}
                isBatchRunning={isBatchRunning}
                onClearLocalCache={handleClearLocalCache}
                environments={environments}
                activeEnvId={activeEnvId}
                editingEnvId={viewMode === 'env-editor' ? editingEnv?.id ?? null : null}
                onSelectActiveEnv={selectActiveEnv}
                onEditEnv={handleEditEnv}
                onCreateEnv={() => handleCreateEnv()}
                onDeleteEnv={handleDeleteEnv}
                history={history}
                onClearHistory={() => {
                  clearHistory();
                  setHistory([]);
                }}
                globalFilter={globalFilter}
                onOpenImport={() => {
                  setMobileMenuOpen(false);
                  setImportModalOpen(true);
                }}
                proxyStatus={proxyStatus}
                onCloseMobile={() => setMobileMenuOpen(false)}
              />
            </div>
          </div>
        )}

        {/* Main Center Workspace */}
        <main id="main-workbench" className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-y-auto lg:overscroll-contain">
          {viewMode === 'env-editor' && editingEnv ? (
            <EnvironmentEditor
              environment={editingEnv}
              isActive={editingEnv.id === activeEnvId}
              sampleTemplateUrl={url}
              onUpdate={handleUpdateEnv}
              onSetActive={() => selectActiveEnv(editingEnv.id)}
              onDuplicate={() => handleDuplicateEnv(editingEnv)}
              onDelete={() => handleDeleteEnv(editingEnv.id)}
              onOpenImportEnv={() => setImportModalOpen(true)}
              onBackToWorkbench={() => setViewMode('request')}
              canDelete={true}
            />
          ) : viewMode === 'batch-runner' ? (
            <BatchRunnerPanel
              steps={displayedBatchSteps}
              activeEnvName={activeEnv?.name ?? null}
              isRunning={isBatchRunning}
              stopOnFailure={batchStopOnFailure}
              onStopOnFailureChange={setBatchStopOnFailure}
              delayMs={batchDelayMs}
              onDelayMsChange={setBatchDelayMs}
              rateLimited={batchMeta.rateLimited}
              aborted={batchMeta.aborted}
              onRun={() => void handleRunBatch()}
              onCancel={handleCancelBatchRun}
              onMoveStep={handleMoveBatchStep}
              onRemoveStep={handleRemoveBatchStep}
              onClearQueue={handleClearBatchSelection}
              onInspectStep={handleInspectBatchStep}
              onBackToWorkbench={() => setViewMode('request')}
            />
          ) : (
            <div className="flex min-h-full w-full min-w-0 flex-1 flex-col">
              <RequestTabBar
                tabs={openTabs}
                activeTabId={activeTab.tabId}
                onSelectTab={handleSelectTab}
                onCloseTab={handleCloseTab}
                onDuplicateTab={handleDuplicateTab}
                onNewTab={() => handleNewBlankRequest(true)}
              />
              <RequestPanel
                requestTitle={requestTitle}
                breadcrumb={breadcrumb}
                method={method}
                url={url}
                queryParams={queryParams}
                headers={headers}
                bodyText={bodyText}
                assertions={assertions}
                onMethodChange={(nextMethod) =>
                  updateActiveTab((t) => ({ ...t, method: nextMethod }))
                }
                onUrlChange={(nextUrl) => updateActiveTab((t) => ({ ...t, url: nextUrl }))}
                onQueryParamsChange={(nextParams) =>
                  updateActiveTab((t) => ({ ...t, queryParams: nextParams }))
                }
                onHeadersChange={(nextHeaders) =>
                  updateActiveTab((t) => ({ ...t, headers: nextHeaders }))
                }
                onBodyTextChange={(nextBody) =>
                  updateActiveTab((t) => ({ ...t, bodyText: nextBody }))
                }
                onAssertionsChange={(nextAssertions) =>
                  updateActiveTab((t) => ({ ...t, assertions: nextAssertions }))
                }
                onExecute={() => void handleExecuteAction()}
                onCancel={isBatchRunning ? handleCancelBatchRun : handleCancelExecute}
                isLoading={isLoading}
                variableRefs={varTracking.references}
                unresolvedVars={varTracking.unresolved}
                resolvedUrlPreview={varTracking.resolvedUrl}
                importWarnings={importWarnings}
                onDismissImportWarnings={() =>
                  updateActiveTab((t) => ({ ...t, importWarnings: [] }))
                }
                activeTab={requestTab}
                onActiveTabChange={(nextTab) =>
                  updateActiveTab((t) => ({ ...t, requestTab: nextTab }))
                }
                activeEnv={effectiveEnv}
                lastResponseBody={lastResponseBody}
                capturedToken={effectiveCapturedToken}
                allowResponseFallback={allowResponseFallback}
                hasCollections={collections.length > 0}
                batchSelectMode={batchSelectMode}
                batchSelectedCount={batchSelectedIds.length}
                isBatchRunning={isBatchRunning}
                onToggleBatchSelectMode={handleToggleBatchSelectMode}
                onOpenBatchRunner={handleOpenBatchRunner}
                bareJwtIssue={bareJwtIssue}
                onFixBareJwtHeader={handleFixBareJwtHeader}
              />

              {batchResults && batchResults.length > 0 && (
                <BatchResultStrip
                  steps={batchResults}
                  isRunning={isBatchRunning}
                  rateLimited={batchMeta.rateLimited}
                  selectedItemId={selectedRequestId}
                  onInspectStep={handleInspectBatchStep}
                  onDismiss={() => {
                    setBatchResults(null);
                    setBatchMeta({ rateLimited: false, aborted: false });
                  }}
                />
              )}

              <ResponsePanel
                isLoading={isLoading}
                elapsedMs={elapsedMs}
                onCancel={handleCancelExecute}
                onRetry={() => void handleExecute()}
                result={result}
                errorResult={errorResult}
                validationError={validationError}
                clientError={clientError}
                networkError={networkError}
                unresolvedVars={varTracking.unresolved}
                activeEnvName={activeEnv?.name ?? null}
                onOpenEnvEditor={() => {
                  if (activeEnv) {
                    setEditingEnvId(activeEnv.id);
                    setViewMode('env-editor');
                  } else if (environments[0]) {
                    setEditingEnvId(environments[0].id);
                    setViewMode('env-editor');
                  } else {
                    handleCreateEnv();
                  }
                }}
                onSelectDefaultEnv={() => {
                  if (environments[0]) {
                    selectActiveEnv(environments[0].id);
                  } else {
                    handleCreateEnv();
                  }
                }}
                defaultEnvName={environments[0]?.name ?? null}
                capturedToken={capturedToken}
                onCaptureToken={(path, value) => {
                  setTokenRevoked(false);
                  setCapturedToken({
                    path,
                    value,
                    origin: lastResultOriginRef.current || currentTargetOrigin,
                  });
                }}
                onClearToken={() => {
                  setCapturedToken(null);
                  setTokenRevoked(true);
                }}
                onInsertBearerHeader={handleInsertBearerHeader}
                onSaveTokenToEnv={handleSaveTokenToEnv}
                envTokenNeedsBearer={envTokenNeedsBearer}
                autoSyncEnvToken={autoSyncEnvToken}
                onToggleAutoSyncEnvToken={() => setAutoSyncEnvToken((v) => !v)}
                activeTab={responseTab}
                onActiveTabChange={(nextTab) =>
                  updateActiveTab((t) => ({ ...t, responseTab: nextTab }))
                }
              />
            </div>
          )}
        </main>

        {/* Right Variables Inspector: Docked on xl+, Slide-Over on < xl */}
        {inspectorOpen && viewMode === 'request' && (
          <>
            <div className="hidden h-full min-h-0 w-72 shrink-0 xl:flex xl:flex-col">
              <VariablesInspector
                activeEnv={activeEnv}
                collectionEnv={activeCollectionEnv}
                references={varTracking.references}
                resolvedUrl={varTracking.resolvedUrl}
                variableSources={mergedEnvInfo.sources}
                collectionEnvName={activeCollectionEnv?.name ?? null}
                onEditEnv={() => {
                  const target = activeEnv ?? activeCollectionEnv ?? environments[0] ?? null;
                  if (target) {
                    setEditingEnvId(target.id);
                    setViewMode('env-editor');
                  } else {
                    handleCreateEnv();
                  }
                }}
                onQuickAddVariable={handleQuickAddVariable}
                onQuickUpdateVariable={handleQuickUpdateVariable}
                onClose={closeInspector}
              />
            </div>

            <div
              className="fixed inset-0 z-40 flex justify-end xl:hidden"
              style={{ backgroundColor: 'var(--scrim)' }}
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) closeInspector();
              }}
            >
              <div className="h-full w-76 max-w-[85vw]">
                <VariablesInspector
                  activeEnv={activeEnv}
                  collectionEnv={activeCollectionEnv}
                  references={varTracking.references}
                  resolvedUrl={varTracking.resolvedUrl}
                  variableSources={mergedEnvInfo.sources}
                  collectionEnvName={activeCollectionEnv?.name ?? null}
                  onEditEnv={() => {
                    closeInspector();
                    const target = activeEnv ?? activeCollectionEnv ?? environments[0] ?? null;
                    if (target) {
                      setEditingEnvId(target.id);
                      setViewMode('env-editor');
                    } else {
                      handleCreateEnv();
                    }
                  }}
                  onQuickAddVariable={(name) => {
                    closeInspector();
                    handleQuickAddVariable(name);
                  }}
                  onQuickUpdateVariable={handleQuickUpdateVariable}
                  onClose={closeInspector}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Import Postman Modal */}
      <ImportPostmanModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImportSingleRequest={(item, colName) => {
          syncOpenTabsToDrafts();
          setViewMode('request');
          commitTabs(
            openImportedSingleTab(openTabsRef.current, activeTabIdRef.current, item, {
              collectionName: colName,
            }),
          );
        }}
        onImportCollectionTree={(collection, firstItem) => {
          setCollections((prev) => [collection, ...prev]);
          setSidebarTab('collections');
          handleSelectRequest(
            {
              ...firstItem,
              warnings: [
                'Asersi tidak diimport: atur manual di tab Assertions.',
                ...firstItem.warnings,
              ],
            },
            collection.name,
          );
        }}
        onImportEnvironment={(env) => {
          setEnvironments((prev) => [env, ...prev]);
          selectActiveEnv(env.id);
          setEditingEnvId(env.id);
          setSidebarTab('envs');
          setViewMode('env-editor');
        }}
      />

      <ConfirmDialog
        open={clearCacheConfirmOpen}
        tone="danger"
        title="Hapus Cache Browser?"
        description="Seluruh Collection dan Environment yang tersimpan di cache lokal (IndexedDB) akan dihapus dari browser ini."
        confirmLabel="Hapus Cache"
        cancelLabel="Batal"
        onConfirm={confirmClearLocalCache}
        onCancel={() => setClearCacheConfirmOpen(false)}
      />
    </div>
  );
};
