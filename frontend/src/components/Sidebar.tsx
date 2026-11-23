import React, { useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  Cancel01Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock01Icon,
  Delete02Icon,
  File01Icon,
  FileImportIcon,
  Folder01Icon,
  Layers01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import type {
  CollectionGroup,
  CollectionRequestItem,
  Environment,
  HistoryEntry,
  HttpMethod,
} from '../types/api';
import { MAX_BATCH_REQUESTS } from '../lib/batchRunner';
import { buildCollectionTree, collectFolderItemIds, type FolderNode } from '../lib/collectionTree';

export type SidebarTab = 'collections' | 'envs' | 'history';

interface SidebarProps {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  collections: CollectionGroup[];
  selectedRequestId: string | null;
  onSelectRequest: (item: CollectionRequestItem, options?: { forceDuplicate?: boolean }) => void;
  onDeleteCollection: (collectionId: string) => void;
  onNewBlankRequest: () => void;
  batchSelectMode: boolean;
  batchSelectedIds: string[];
  onToggleBatchItem: (itemId: string) => void;
  onToggleBatchFolder: (itemIds: string[]) => void;
  onClearBatchSelection: () => void;
  isBatchRunning: boolean;
  onClearLocalCache: () => void;
  environments: Environment[];
  activeEnvId: string | null;
  editingEnvId: string | null;
  onSelectActiveEnv: (id: string) => void;
  onEditEnv: (id: string) => void;
  onCreateEnv: () => void;
  onDeleteEnv: (id: string) => void;
  history: HistoryEntry[];
  onClearHistory: () => void;
  globalFilter: string;
  onOpenImport: () => void;
  proxyStatus: 'idle' | 'online' | 'offline';
  filterInputRef?: React.RefObject<HTMLInputElement | null>;
  onCloseMobile?: () => void;
}

const METHOD_COLOR_VAR: Record<HttpMethod, string> = {
  GET: 'var(--method-get)',
  POST: 'var(--method-post)',
  PUT: 'var(--method-put)',
  PATCH: 'var(--method-patch)',
  DELETE: 'var(--method-delete)',
};

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  collections,
  selectedRequestId,
  onSelectRequest,
  onDeleteCollection,
  onNewBlankRequest,
  batchSelectMode,
  batchSelectedIds,
  onToggleBatchItem,
  onToggleBatchFolder,
  onClearBatchSelection,
  isBatchRunning,
  onClearLocalCache,
  environments,
  activeEnvId,
  editingEnvId,
  onSelectActiveEnv,
  onEditEnv,
  onCreateEnv,
  onDeleteEnv,
  history,
  onClearHistory,
  globalFilter,
  onOpenImport,
  proxyStatus,
  filterInputRef,
  onCloseMobile,
}) => {
  const [localFilter, setLocalFilter] = useState('');
  const [collapsedCols, setCollapsedCols] = useState<Record<string, boolean>>({});
  const [folderOpenOverrides, setFolderOpenOverrides] = useState<Record<string, boolean>>({});
  const [selectedHistoryIdx, setSelectedHistoryIdx] = useState<number | null>(null);

  const showBatchChecks = batchSelectMode || batchSelectedIds.length > 0;
  const batchOrderMap = useMemo(() => {
    const map = new Map<string, number>();
    batchSelectedIds.forEach((id, idx) => map.set(id, idx + 1));
    return map;
  }, [batchSelectedIds]);

  const effectiveFilter = (localFilter || globalFilter).trim().toLowerCase();

  const filteredCollections = useMemo(() => {
    if (!effectiveFilter) return collections;
    return collections
      .map((col) => ({
        ...col,
        items: col.items.filter(
          (item) =>
            item.name.toLowerCase().includes(effectiveFilter) ||
            item.url.toLowerCase().includes(effectiveFilter) ||
            item.folderPath.join(' ').toLowerCase().includes(effectiveFilter),
        ),
      }))
      .filter((col) => col.items.length > 0 || col.name.toLowerCase().includes(effectiveFilter));
  }, [collections, effectiveFilter]);

  const filteredEnvs = useMemo(() => {
    if (!effectiveFilter) return environments;
    return environments.filter((env) => env.name.toLowerCase().includes(effectiveFilter));
  }, [environments, effectiveFilter]);

  const renderRequestRow = (item: CollectionRequestItem, depth: number) => {
    const active = item.id === selectedRequestId;
    const orderNum = batchOrderMap.get(item.id);
    const isChecked = orderNum !== undefined;
    const disableCheck =
      isBatchRunning || (!isChecked && batchSelectedIds.length >= MAX_BATCH_REQUESTS);

    return (
      <div
        key={item.id}
        className="relative flex min-h-9 w-full items-center gap-1 rounded-md px-1.5 transition-colors"
        style={{
          backgroundColor: active ? 'var(--surface-recessed)' : 'transparent',
          paddingLeft: depth > 0 ? `${depth * 0.75 + 0.375}rem` : undefined,
        }}
      >
        {active && (
          <span
            className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
            style={{ backgroundColor: 'var(--brand-action)' }}
            aria-hidden="true"
          />
        )}
        {showBatchChecks && (
          <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 py-1">
            <input
              type="checkbox"
              checked={isChecked}
              disabled={disableCheck}
              onChange={() => onToggleBatchItem(item.id)}
              aria-label={`Pilih ${item.name} untuk eksekusi berurutan`}
              className="h-3.5 w-3.5 accent-[var(--brand-action)] disabled:opacity-40"
            />
            {isChecked && (
              <span
                className="rounded px-1 py-0.5 font-mono text-[9px] font-bold"
                style={{
                  backgroundColor: 'var(--brand-tint)',
                  color: 'var(--brand-tint-text)',
                }}
              >
                #{orderNum}
              </span>
            )}
          </label>
        )}
        <button
          type="button"
          onClick={(e) => {
            onSelectRequest(item, { forceDuplicate: e.ctrlKey || e.metaKey });
            onCloseMobile?.();
          }}
          title={`${item.method} ${item.name} (Ctrl+Klik untuk duplikat tab)`}
          aria-current={active ? 'page' : undefined}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-left text-xs"
          style={{
            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontWeight: active ? 600 : 400,
          }}
        >
          <span
            className="w-9 shrink-0 font-mono text-[10px] font-bold"
            style={{ color: METHOD_COLOR_VAR[item.method] }}
          >
            {item.method === 'DELETE' ? 'DEL' : item.method}
          </span>
          <HugeiconsIcon
            icon={File01Icon}
            size={12}
            strokeWidth={1.7}
            className="shrink-0"
            style={{
              color: active ? 'var(--brand-tint-text)' : 'var(--text-muted)',
            }}
          />
          <span className="truncate">{item.name}</span>
        </button>
      </div>
    );
  };

  const renderFolderNode = (
    node: FolderNode,
    depth: number,
    siblingIndex: number,
    siblingCount: number,
  ): React.ReactNode => {
    const folderKey = node.key;
    const containsActive = node.items.some((it) => it.id === selectedRequestId);
    const defaultExpanded = siblingCount <= 5 || siblingIndex === 0 || containsActive;
    const isFolderExpanded =
      effectiveFilter !== ''
        ? true
        : folderOpenOverrides[folderKey] ?? defaultExpanded;

    const descendantIds = collectFolderItemIds(node);
    const allSelected =
      descendantIds.length > 0 && descendantIds.every((id) => batchOrderMap.has(id));

    return (
      <div key={folderKey} className="space-y-0.5">
        <div
          className="flex items-center gap-1"
          style={depth > 0 ? { paddingLeft: `${depth * 0.75}rem` } : undefined}
        >
          {showBatchChecks && (
            <input
              type="checkbox"
              checked={allSelected}
              disabled={isBatchRunning}
              onChange={() => onToggleBatchFolder(descendantIds)}
              aria-label={`Pilih semua request di folder ${node.name}`}
              title={
                allSelected
                  ? `Batalkan semua di ${node.name}`
                  : `Pilih request di ${node.name} (maks. ${MAX_BATCH_REQUESTS})`
              }
              className="ml-1 h-3.5 w-3.5 shrink-0 accent-[var(--brand-action)]"
            />
          )}
          <button
            type="button"
            onClick={() =>
              setFolderOpenOverrides((prev) => ({ ...prev, [folderKey]: !isFolderExpanded }))
            }
            aria-expanded={isFolderExpanded}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] font-semibold"
            style={{ color: 'var(--text-secondary)' }}
          >
            <HugeiconsIcon
              icon={isFolderExpanded ? ChevronDownIcon : ChevronRightIcon}
              size={12}
              strokeWidth={2}
              className="shrink-0"
            />
            <HugeiconsIcon
              icon={Folder01Icon}
              size={13}
              strokeWidth={1.8}
              className="shrink-0"
              style={{
                color: isFolderExpanded ? 'var(--brand-tint-text)' : 'var(--text-muted)',
              }}
            />
            <span className="truncate">{node.name}</span>
            <span
              className="ml-auto text-[10px] font-normal"
              style={{ color: 'var(--text-muted)' }}
            >
              {node.totalCount}
            </span>
          </button>
        </div>
        {isFolderExpanded && (
          <div className="space-y-0.5">
            {node.folders.map((child, idx) =>
              renderFolderNode(child, depth + 1, idx, node.folders.length),
            )}
            {node.items.map((item) => renderRequestRow(item, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      id="workbench-sidebar"
      aria-label="Navigasi Collections, Environments, dan Riwayat"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden border-r"
      style={{
        backgroundColor: 'var(--surface-elevated)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      {/* Tab Bar */}
      <div
        role="tablist"
        aria-label="Bagian sidebar"
        className="flex items-center border-b px-2"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        {(
          [
            { id: 'collections', label: 'Collections', icon: Folder01Icon },
            { id: 'envs', label: `Envs (${environments.length})`, icon: Layers01Icon },
            { id: 'history', label: `Riwayat (${history.length})`, icon: Clock01Icon },
          ] as const
        ).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onTabChange(tab.id)}
              className="relative flex flex-1 min-h-10 items-center justify-center gap-1 px-1 text-center text-[11px] transition-colors"
              style={{
                color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: isActive ? 600 : 400,
              }}
            >
              <HugeiconsIcon icon={tab.icon} size={13} strokeWidth={1.8} />
              <span className="truncate">{tab.label}</span>
              {isActive && (
                <span
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-t"
                  style={{ backgroundColor: 'var(--brand-action)' }}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Filter & Quick Add */}
      <div className="flex items-center gap-1.5 p-2.5">
        <label htmlFor="sidebar-filter-input" className="sr-only">
          Filter item sidebar
        </label>
        <div
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2"
          style={{
            backgroundColor: 'var(--surface-recessed)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={1.8}
            className="shrink-0"
            style={{ color: 'var(--text-muted)' }}
          />
          <input
            ref={filterInputRef}
            id="sidebar-filter-input"
            type="search"
            value={localFilter}
            onChange={(e) => setLocalFilter(e.target.value)}
            placeholder={
              activeTab === 'collections'
                ? 'Filter request...'
                : activeTab === 'envs'
                  ? 'Filter environment...'
                  : 'Filter riwayat...'
            }
            className="h-full min-w-0 flex-1 bg-transparent text-xs"
            style={{ color: 'var(--text-primary)' }}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (activeTab === 'envs') {
              onCreateEnv();
            } else {
              onNewBlankRequest();
            }
            onCloseMobile?.();
          }}
          aria-label={activeTab === 'envs' ? 'Buat environment baru' : 'Buat request kosong baru'}
          title={activeTab === 'envs' ? 'Buat environment baru' : 'Request kosong baru'}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
          style={{
            backgroundColor: 'var(--surface-recessed)',
            borderColor: 'var(--border-control)',
            color: 'var(--text-primary)',
          }}
        >
          <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Main Scroll Area */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {activeTab === 'collections' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-1 px-1.5">
              <span
                className="text-[10px] font-semibold tracking-wider uppercase"
                style={{ color: 'var(--text-muted)' }}
              >
                Collections (Sesi Browser)
              </span>
              <button
                type="button"
                onClick={onOpenImport}
                className="inline-flex items-center gap-1 text-[11px] font-semibold"
                style={{ color: 'var(--brand-tint-text)' }}
              >
                <HugeiconsIcon icon={FileImportIcon} size={12} strokeWidth={1.8} />
                <span>Import</span>
              </button>
            </div>

            {showBatchChecks && (
              <div
                className="flex items-center justify-between gap-2 px-1.5 text-[11px]"
                style={{ color: 'var(--text-muted)' }}
              >
                <span>
                  <strong style={{ color: 'var(--brand-tint-text)' }}>
                    {batchSelectedIds.length}/{MAX_BATCH_REQUESTS}
                  </strong>{' '}
                  dipilih · klik tombol di sebelah Execute
                </span>
                {batchSelectedIds.length > 0 && !isBatchRunning && (
                  <button
                    type="button"
                    onClick={onClearBatchSelection}
                    className="shrink-0 text-[10px] font-semibold"
                    style={{ color: 'var(--status-fail-fg)' }}
                  >
                    Reset
                  </button>
                )}
              </div>
            )}

            {filteredCollections.length === 0 ? (
              <div
                className="rounded-md border p-3 text-xs leading-relaxed"
                style={{
                  backgroundColor: 'var(--surface-recessed)',
                  borderColor: 'var(--border-hairline)',
                  color: 'var(--text-secondary)',
                }}
              >
                {collections.length === 0
                  ? 'Belum ada collection. Klik "Import" untuk memuat dari Postman, Bruno (.json / .bru), atau repo GitHub, atau langsung tulis URL di panel kanan.'
                  : 'Tidak ada request yang cocok dengan filter.'}
              </div>
            ) : (
              filteredCollections.map((col) => {
                const isCollapsed = Boolean(collapsedCols[col.id]);
                const tree = buildCollectionTree(col.items);

                return (
                  <div key={col.id} className="space-y-1">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsedCols((prev) => ({ ...prev, [col.id]: !prev[col.id] }))
                        }
                        aria-expanded={!isCollapsed}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        <HugeiconsIcon
                          icon={isCollapsed ? ChevronRightIcon : ChevronDownIcon}
                          size={13}
                          strokeWidth={2}
                          className="shrink-0"
                        />
                        <span className="truncate">{col.name}</span>
                        <span
                          className="ml-auto text-[10px] font-normal"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {col.items.length}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteCollection(col.id)}
                        aria-label={`Hapus collection ${col.name}`}
                        title="Hapus collection dari sesi"
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                      </button>
                    </div>

                    {!isCollapsed && (
                      <>
                        {tree.folders.map((folder, folderIdx) =>
                          renderFolderNode(folder, 0, folderIdx, tree.folders.length),
                        )}
                        {tree.rootItems.length > 0 && (
                          <div className="space-y-0.5 pl-2">
                            {tree.rootItems.map((item) =>
                              renderRequestRow(item, 0),
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === 'envs' && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => {
                onCreateEnv();
                onCloseMobile?.();
              }}
              className="flex min-h-9 w-full items-center justify-center rounded-md border px-3 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--brand-tint)',
                borderColor: 'var(--brand-tint-border)',
                color: 'var(--brand-tint-text)',
              }}
            >
              + Buat Environment Baru
            </button>

            <div className="space-y-1">
              {filteredEnvs.map((env) => {
                const isActive = env.id === activeEnvId;
                const isEditing = env.id === editingEnvId;
                return (
                  <div
                    key={env.id}
                    className="relative flex items-center justify-between gap-1 rounded-md border px-2 py-1.5"
                    style={{
                      backgroundColor: isEditing ? 'var(--surface-recessed)' : 'transparent',
                      borderColor: isEditing ? 'var(--border-control)' : 'transparent',
                    }}
                  >
                    {isEditing && (
                      <span
                        className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
                        style={{ backgroundColor: 'var(--brand-action)' }}
                        aria-hidden="true"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onEditEnv(env.id);
                        onCloseMobile?.();
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span
                        className="block truncate text-xs font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {env.name}
                      </span>
                      <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {env.variables.length} variabel
                      </span>
                    </button>

                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectActiveEnv(env.id)}
                        aria-label={`Aktifkan environment ${env.name}`}
                        className="shrink-0 rounded px-2 py-1 text-[10px] font-bold"
                        style={
                          isActive
                            ? {
                                backgroundColor: 'var(--status-pass-bg)',
                                color: 'var(--status-pass-fg)',
                                border: '1px solid var(--status-pass-border)',
                              }
                            : {
                                backgroundColor: 'var(--surface-recessed)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-hairline)',
                              }
                        }
                      >
                        {isActive ? 'AKTIF' : 'Pakai'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteEnv(env.id)}
                        aria-label={`Hapus environment ${env.name}`}
                        title="Hapus environment dari sesi"
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        x
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Maks. 50 ringkasan (tanpa body/header)
              </span>
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onClearHistory();
                    setSelectedHistoryIdx(null);
                  }}
                  className="text-[11px] font-semibold"
                  style={{ color: 'var(--status-fail-fg)' }}
                >
                  Hapus
                </button>
              )}
            </div>

            {history.length === 0 ? (
              <div
                className="rounded-md border p-3 text-xs"
                style={{
                  backgroundColor: 'var(--surface-recessed)',
                  borderColor: 'var(--border-hairline)',
                  color: 'var(--text-secondary)',
                }}
              >
                Belum ada riwayat eksekusi. Jalankan pengujian pertama untuk mencatat ringkasan verdict di sini.
              </div>
            ) : (
              <div className="space-y-1.5">
                {history
                  .filter(
                    (h) =>
                      !effectiveFilter ||
                      h.url.toLowerCase().includes(effectiveFilter) ||
                      h.method.toLowerCase().includes(effectiveFilter),
                  )
                  .map((entry, idx) => {
                    const expanded = selectedHistoryIdx === idx;
                    const badgeStyle =
                      entry.overallStatus === 'PASS'
                        ? {
                            bg: 'var(--status-pass-bg)',
                            fg: 'var(--status-pass-fg)',
                          }
                        : entry.overallStatus === 'FAIL'
                          ? {
                              bg: 'var(--status-fail-bg)',
                              fg: 'var(--status-fail-fg)',
                            }
                          : {
                              bg: 'var(--status-error-bg)',
                              fg: 'var(--status-error-fg)',
                            };

                    return (
                      <div
                        key={`${entry.timestamp}_${idx}`}
                        className="rounded-md border p-2"
                        style={{
                          backgroundColor: 'var(--surface-recessed)',
                          borderColor: 'var(--border-hairline)',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedHistoryIdx(expanded ? null : idx)}
                          aria-expanded={expanded}
                          className="w-full text-left"
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            <span
                              className="font-mono text-[10px] font-bold"
                              style={{ color: METHOD_COLOR_VAR[entry.method] }}
                            >
                              {entry.method}
                            </span>
                            <span
                              className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                              style={{ backgroundColor: badgeStyle.bg, color: badgeStyle.fg }}
                            >
                              {entry.overallStatus}
                            </span>
                          </div>
                          <p
                            className="mt-1 truncate font-mono text-[11px]"
                            style={{ color: 'var(--text-primary)' }}
                            title={entry.url}
                          >
                            {entry.url}
                          </p>
                          <p className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {new Date(entry.timestamp).toLocaleTimeString('id-ID')} ·{' '}
                            {entry.passedCount} pass, {entry.failedCount} fail
                          </p>
                        </button>

                        {expanded && (
                          <div
                            className="mt-2 border-t pt-2 text-[11px]"
                            style={{
                              borderColor: 'var(--border-hairline)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            <p className="break-all font-mono">{entry.url}</p>
                            <p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              Ringkasan saja: header dan body tidak disimpan di localStorage demi keamanan kredensial.
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pinned Environments Shortcut (visible when on Collections tab) */}
      {activeTab === 'collections' && (
        <div
          className="border-t p-2.5"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span
              className="text-[10px] font-semibold tracking-wider uppercase"
              style={{ color: 'var(--text-muted)' }}
            >
              Environments
            </span>
            <button
              type="button"
              onClick={() => {
                onCreateEnv();
                onCloseMobile?.();
              }}
              className="text-[11px] font-semibold"
              style={{ color: 'var(--brand-tint-text)' }}
            >
              + Baru
            </button>
          </div>
          <div className="max-h-36 space-y-0.5 overflow-y-auto">
            {environments.length === 0 ? (
              <p className="px-1 py-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Belum ada environment.
              </p>
            ) : (
              environments.map((env) => {
                const isActive = env.id === activeEnvId;
                return (
                  <div
                    key={env.id}
                    className="flex items-center justify-between rounded px-2 py-1"
                    style={{
                      backgroundColor: isActive ? 'var(--surface-recessed)' : 'transparent',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onEditEnv(env.id);
                        onCloseMobile?.();
                      }}
                      className="min-w-0 flex-1 truncate text-left text-xs"
                      style={{
                        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                        fontWeight: isActive ? 600 : 400,
                      }}
                    >
                      {env.name}
                    </button>
                    <div className="ml-1.5 flex shrink-0 items-center gap-1">
                      {isActive ? (
                        <span
                          className="rounded px-1.5 py-0.5 text-[9px] font-bold"
                          style={{
                            backgroundColor: 'var(--status-pass-bg)',
                            color: 'var(--status-pass-fg)',
                          }}
                        >
                          ACTIVE
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onSelectActiveEnv(env.id)}
                          className="text-[10px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Aktifkan
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onDeleteEnv(env.id)}
                        aria-label={`Hapus environment ${env.name}`}
                        title="Hapus environment dari sesi"
                        className="inline-flex h-5 w-5 items-center justify-center rounded"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Footer Proxy Status & Local IndexedDB Cache Reset */}
      <div
        className="space-y-1.5 border-t px-3 py-2 text-[11px]"
        style={{
          borderColor: 'var(--border-hairline)',
          color: 'var(--text-muted)',
        }}
      >
        {(collections.length > 0 || environments.length > 0) && (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[10px]">
              Cache lokal (IndexedDB · tanpa secret)
            </span>
            <button
              type="button"
              disabled={isBatchRunning}
              onClick={onClearLocalCache}
              className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold disabled:opacity-45"
              style={{ color: 'var(--status-fail-fg)' }}
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.8} />
              <span>Hapus Cache</span>
            </button>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate">
            Proxy: <span className="font-mono">/api/proxy/execute</span>
          </span>
          <span
            className="inline-flex shrink-0 items-center gap-1 font-semibold"
            style={{
              color:
                proxyStatus === 'online'
                  ? 'var(--status-pass-fg)'
                  : proxyStatus === 'offline'
                    ? 'var(--status-fail-fg)'
                    : 'var(--text-muted)',
            }}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor:
                  proxyStatus === 'online'
                    ? 'var(--status-pass-fg)'
                    : proxyStatus === 'offline'
                      ? 'var(--status-fail-fg)'
                      : 'var(--text-muted)',
              }}
              aria-hidden="true"
            />
            {proxyStatus === 'online' ? 'Terhubung' : proxyStatus === 'offline' ? 'Offline' : 'Siap'}
          </span>
        </div>
      </div>
    </aside>
  );
};
