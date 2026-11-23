import React, { useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkBadge03Icon,
  CodeIcon,
  FilterIcon,
  Key01Icon,
  ListOrderedIcon,
  PlayIcon,
  Shield01Icon,
  StopIcon,
} from '@hugeicons/core-free-icons';
import {
  ALLOWED_METHODS,
  type AssertionDraft,
  type Environment,
  type HttpMethod,
  type KeyValueRow,
} from '../types/api';
import {
  extractPlaceholderNames,
  parseJsonBodyText,
  validateJsonTemplateSyntax,
  type ResolvedVariableRef,
} from '../lib/variables';
import type { BearerHeaderIssue } from '../lib/postResponseScripts';
import { KeyValueEditor } from './KeyValueEditor';
import { AssertionConfigurator } from './AssertionConfigurator';

export type RequestTab = 'params' | 'headers' | 'body' | 'assertions';

interface RequestPanelProps {
  requestTitle: string;
  breadcrumb: string;
  method: HttpMethod;
  url: string;
  queryParams: KeyValueRow[];
  headers: KeyValueRow[];
  bodyText: string;
  assertions: AssertionDraft[];
  onMethodChange: (m: HttpMethod) => void;
  onUrlChange: (u: string) => void;
  onQueryParamsChange: (rows: KeyValueRow[]) => void;
  onHeadersChange: (rows: KeyValueRow[]) => void;
  onBodyTextChange: (text: string) => void;
  onAssertionsChange: (rules: AssertionDraft[]) => void;
  onExecute: () => void;
  onCancel: () => void;
  isLoading: boolean;
  variableRefs: ResolvedVariableRef[];
  unresolvedVars: string[];
  resolvedUrlPreview: string;
  importWarnings: string[];
  onDismissImportWarnings: () => void;
  activeTab: RequestTab;
  onActiveTabChange: (tab: RequestTab) => void;
  activeEnv: Environment | null;
  lastResponseBody: unknown;
  capturedToken: { path: string; value: string } | null;
  allowResponseFallback?: boolean;
  hasCollections?: boolean;
  batchSelectMode?: boolean;
  batchSelectedCount?: number;
  isBatchRunning?: boolean;
  onToggleBatchSelectMode?: () => void;
  onOpenBatchRunner?: () => void;
  bareJwtIssue?: BearerHeaderIssue | null;
  onFixBareJwtHeader?: () => void;
}

export const METHOD_COLOR_VAR: Record<HttpMethod, string> = {
  GET: 'var(--method-get)',
  POST: 'var(--method-post)',
  PUT: 'var(--method-put)',
  PATCH: 'var(--method-patch)',
  DELETE: 'var(--method-delete)',
};

export const RequestPanel: React.FC<RequestPanelProps> = ({
  requestTitle,
  breadcrumb,
  method,
  url,
  queryParams,
  headers,
  bodyText,
  assertions,
  onMethodChange,
  onUrlChange,
  onQueryParamsChange,
  onHeadersChange,
  onBodyTextChange,
  onAssertionsChange,
  onExecute,
  onCancel,
  isLoading,
  variableRefs,
  unresolvedVars,
  resolvedUrlPreview,
  importWarnings,
  onDismissImportWarnings,
  activeTab,
  onActiveTabChange,
  activeEnv,
  lastResponseBody,
  capturedToken,
  allowResponseFallback = true,
  hasCollections = false,
  batchSelectMode = false,
  batchSelectedCount = 0,
  isBatchRunning = false,
  onToggleBatchSelectMode,
  onOpenBatchRunner,
  bareJwtIssue = null,
  onFixBareJwtHeader,
}) => {
  const [formatNotice, setFormatNotice] = useState<string | null>(null);

  const urlPlaceholders = useMemo(() => extractPlaceholderNames(url), [url]);
  const unresolvedSet = useMemo(() => new Set(unresolvedVars), [unresolvedVars]);
  const refMap = useMemo(() => new Map(variableRefs.map((r) => [r.name, r])), [variableRefs]);

  const jsonCheck = useMemo(() => {
    if (method === 'GET' || bodyText.trim() === '') return { ok: true as const };
    return validateJsonTemplateSyntax(
      bodyText,
      activeEnv,
      lastResponseBody,
      capturedToken,
      allowResponseFallback,
    );
  }, [method, bodyText, activeEnv, lastResponseBody, capturedToken, allowResponseFallback]);

  const enabledParamsCount = queryParams.filter((r) => r.enabled && r.key.trim()).length;
  const enabledHeadersCount = headers.filter((r) => r.enabled && r.key.trim()).length;
  const enabledAssertionsCount = assertions.filter((a) => a.enabled).length;

  const urlSchemeWarning = useMemo(() => {
    const trimmed = resolvedUrlPreview.trim();
    if (!trimmed) return null;
    if (unresolvedVars.length > 0) return null;
    if (!/^https?:\/\/.+/i.test(trimmed)) {
      return 'URL harus diawali http:// atau https:// dengan host yang valid.';
    }
    return null;
  }, [resolvedUrlPreview, unresolvedVars]);

  const handleFormatJson = () => {
    setFormatNotice(null);
    const parsed = parseJsonBodyText(bodyText);
    if (!parsed.ok) {
      setFormatNotice(`Tidak bisa memformat JSON: ${parsed.error}`);
      return;
    }
    if (parsed.value !== undefined) {
      onBodyTextChange(JSON.stringify(parsed.value, null, 2));
    }
  };

  return (
    <section
      aria-label="Request Builder dan Assertion Configurator"
      className="flex min-w-0 flex-col border-b"
      style={{
        backgroundColor: 'var(--surface-canvas)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      {/* Request Strip / Breadcrumb */}
      <div
        className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-4"
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="font-mono text-[11px] font-bold"
            style={{ color: METHOD_COLOR_VAR[method] }}
          >
            {method}
          </span>
          <span
            className="truncate text-xs font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            {requestTitle}
          </span>
        </div>
        <span className="hidden truncate text-[11px] sm:inline" style={{ color: 'var(--text-muted)' }}>
          {breadcrumb}
        </span>
      </div>

      {/* URL Bar + Execute CTA */}
      <div className="min-w-0 space-y-2 px-3 pt-3 pb-2 sm:px-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const inMultiRun = batchSelectMode || batchSelectedCount > 0;
            if (isLoading || isBatchRunning) return;
            if (inMultiRun && batchSelectedCount === 0) return;
            onExecute();
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <div
            className="flex min-w-0 flex-1 items-center rounded-md border"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor:
                unresolvedVars.length > 0 || urlSchemeWarning
                  ? 'var(--status-fail-border)'
                  : 'var(--border-control)',
            }}
          >
            <label htmlFor="http-method-select" className="sr-only">
              HTTP Method
            </label>
            <select
              id="http-method-select"
              value={method}
              onChange={(e) => onMethodChange(e.target.value as HttpMethod)}
              className="h-11 shrink-0 rounded-l-md border-r bg-transparent px-3 font-mono text-xs font-bold sm:h-10"
              style={{
                borderColor: 'var(--border-hairline)',
                color: METHOD_COLOR_VAR[method],
              }}
            >
              {ALLOWED_METHODS.map((m) => (
                <option
                  key={m}
                  value={m}
                  style={{
                    backgroundColor: 'var(--surface-elevated)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {m}
                </option>
              ))}
            </select>

            <label htmlFor="request-url-input" className="sr-only">
              Endpoint URL target
            </label>
            <input
              id="request-url-input"
              type="text"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              placeholder="https://api.example.com/v1/endpoint atau {{url}}/api/..."
              spellCheck={false}
              className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-xs sm:h-10"
              style={{ color: 'var(--text-primary)' }}
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {(batchSelectMode || batchSelectedCount > 0 || isBatchRunning) ? (
              <div className="flex shrink-0 items-center gap-1.5">
                {batchSelectedCount > 0 && !isBatchRunning && onOpenBatchRunner && (
                  <button
                    type="button"
                    onClick={onOpenBatchRunner}
                    title={`Atur urutan dan opsi ${batchSelectedCount} request terpilih`}
                    className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold transition-colors sm:h-10"
                    style={{
                      backgroundColor: 'var(--surface-elevated)',
                      borderColor: 'var(--border-control)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <HugeiconsIcon icon={ListOrderedIcon} size={14} strokeWidth={1.8} />
                    <span>Urutan ({batchSelectedCount})</span>
                  </button>
                )}
                {!isBatchRunning && onToggleBatchSelectMode && (
                  <button
                    type="button"
                    onClick={onToggleBatchSelectMode}
                    aria-pressed={true}
                    title="Keluar dari mode Multi-Run & reset pilihan"
                    className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold transition-colors sm:h-10"
                    style={{
                      backgroundColor: 'var(--brand-tint)',
                      borderColor: 'var(--brand-tint-border)',
                      color: 'var(--brand-tint-text)',
                    }}
                  >
                    <span>Multi-Run: ON</span>
                    <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
                  </button>
                )}
              </div>
            ) : (
              hasCollections &&
              onToggleBatchSelectMode && (
                <button
                  type="button"
                  onClick={onToggleBatchSelectMode}
                  aria-pressed={false}
                  title="Aktifkan checklist di sidebar untuk menjalankan beberapa endpoint secara berurutan"
                  className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border px-3.5 text-xs font-semibold transition-colors sm:h-10"
                  style={{
                    backgroundColor: 'var(--surface-elevated)',
                    borderColor: 'var(--border-control)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <HugeiconsIcon icon={ListOrderedIcon} size={14} strokeWidth={1.8} />
                  <span>Multi-Run</span>
                </button>
              )
            )}

            {isLoading || isBatchRunning ? (
              <button
                type="button"
                onClick={onCancel}
                className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md border px-5 text-xs font-bold sm:h-10 sm:flex-initial"
                style={{
                  backgroundColor: 'var(--status-fail-bg)',
                  borderColor: 'var(--status-fail-border)',
                  color: 'var(--status-fail-fg)',
                }}
              >
                <HugeiconsIcon icon={StopIcon} size={14} strokeWidth={2} />
                <span>Batalkan</span>
              </button>
            ) : batchSelectMode || batchSelectedCount > 0 ? (
              <button
                type="submit"
                disabled={batchSelectedCount === 0}
                title={
                  batchSelectedCount === 0
                    ? 'Centang minimal 1 endpoint di Sidebar untuk menjalankan Multi-Run'
                    : `Jalankan ${batchSelectedCount} endpoint terpilih secara berurutan (Ctrl+Enter)`
                }
                className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-5 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45 sm:h-10 sm:flex-initial"
                style={{
                  backgroundColor: 'var(--brand-action)',
                  color: 'var(--brand-on-action)',
                }}
              >
                <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={2} />
                <span>Execute ({batchSelectedCount})</span>
              </button>
            ) : (
              <button
                type="submit"
                title="Jalankan request (Ctrl+Enter)"
                className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-5 text-xs font-bold transition-colors sm:h-10 sm:flex-initial"
                style={{
                  backgroundColor: 'var(--brand-action)',
                  color: 'var(--brand-on-action)',
                }}
              >
                <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={2} />
                <span>Execute</span>
              </button>
            )}
          </div>
        </form>

        {/* Live Variable Pills + Resolved URL Preview */}
        {(urlPlaceholders.length > 0 || enabledParamsCount > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {urlPlaceholders.map((name) => {
              const isUnresolved = unresolvedSet.has(name);
              const ref = refMap.get(name);
              return (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold"
                  style={
                    isUnresolved
                      ? {
                          backgroundColor: 'var(--status-fail-bg)',
                          borderColor: 'var(--status-fail-border)',
                          color: 'var(--status-fail-fg)',
                        }
                      : {
                          backgroundColor: 'var(--brand-tint)',
                          borderColor: 'var(--brand-tint-border)',
                          color: 'var(--brand-tint-text)',
                        }
                  }
                  title={
                    isUnresolved
                      ? 'Variabel belum terdefinisi pada Environment aktif'
                      : `Resolved: ${ref?.isSecret ? '********' : ref?.resolvedValue ?? ''}`
                  }
                >
                  <span>{`{{${name}}}`}</span>
                  <span className="font-sans text-[10px] font-normal">
                    {isUnresolved ? 'belum ada' : 'ok'}
                  </span>
                </span>
              );
            })}
            {resolvedUrlPreview && (
              <span
                className="w-full min-w-0 break-all font-mono text-[11px] sm:w-auto sm:truncate"
                style={{ color: 'var(--text-muted)' }}
                title={resolvedUrlPreview}
              >
                Target: {resolvedUrlPreview}
              </span>
            )}
          </div>
        )}

        {urlSchemeWarning && (
          <p role="alert" className="text-xs font-medium" style={{ color: 'var(--status-fail-fg)' }}>
            {urlSchemeWarning}
          </p>
        )}

        {bareJwtIssue && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--status-warn-bg)',
              borderColor: 'var(--status-warn-border)',
              color: 'var(--status-warn-fg)',
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 text-[11px] leading-relaxed">
              <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.8} className="shrink-0" />
              <span>
                Header <code className="font-mono font-bold">Authorization</code> berisi token JWT tanpa prefix{' '}
                <code className="font-mono font-bold">Bearer </code> — server JWT (mis. Laravel) umumnya menolak dengan{' '}
                <code className="font-mono">404 / Authorization Token not found</code>.
              </span>
            </span>
            {onFixBareJwtHeader && (
              <button
                type="button"
                onClick={onFixBareJwtHeader}
                className="inline-flex shrink-0 items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] font-bold"
                style={{
                  backgroundColor: 'var(--brand-action)',
                  borderColor: 'var(--brand-action)',
                  color: 'var(--brand-on-action)',
                }}
              >
                <HugeiconsIcon icon={Key01Icon} size={12} strokeWidth={2} />
                <span>Tambahkan prefix "Bearer "</span>
              </button>
            )}
          </div>
        )}

        {/* PRD v1.5 Import Warnings Banner */}
        {importWarnings.length > 0 && (
          <div
            role="status"
            className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--status-warn-bg)',
              borderColor: 'var(--status-warn-border)',
              color: 'var(--status-warn-fg)',
            }}
          >
            <div className="space-y-1">
              <p className="font-semibold">
                Catatan Import Postman (periksa sebelum Execute):
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
                {importWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={onDismissImportWarnings}
              aria-label="Tutup peringatan import"
              className="shrink-0 rounded px-2 py-0.5 text-xs font-semibold"
            >
              Tutup
            </button>
          </div>
        )}
      </div>

      {/* Request Config Sub-tabs */}
      <div
        role="tablist"
        aria-label="Konfigurasi Request dan Assertion"
        className="flex flex-wrap items-center gap-0.5 border-b px-3 sm:gap-1 sm:px-4"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        {(
          [
            { id: 'params', label: 'Params', count: enabledParamsCount, icon: FilterIcon },
            { id: 'headers', label: 'Headers', count: enabledHeadersCount, icon: Shield01Icon },
            { id: 'body', label: 'Body', count: method !== 'GET' && bodyText.trim() ? 1 : 0, icon: CodeIcon },
            { id: 'assertions', label: 'Assertions', count: enabledAssertionsCount, accent: true, icon: CheckmarkBadge03Icon },
          ] as const
        ).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onActiveTabChange(tab.id)}
              className="relative inline-flex min-h-11 items-center gap-1 px-2 text-xs transition-colors sm:min-h-10 sm:gap-1.5 sm:px-3"
              style={{
                color: isActive
                  ? 'var(--text-primary)'
                  : 'accent' in tab && tab.accent
                    ? 'var(--brand-tint-text)'
                    : 'var(--text-secondary)',
                fontWeight: isActive || ('accent' in tab && tab.accent) ? 600 : 400,
              }}
            >
              <HugeiconsIcon icon={tab.icon} size={13} strokeWidth={1.8} />
              <span>{tab.label}</span>
              {tab.count > 0 && (
                <span
                  className="rounded-full px-1.5 py-0.5 font-mono text-[10px]"
                  style={{
                    backgroundColor:
                      'accent' in tab && tab.accent
                        ? 'var(--brand-tint)'
                        : 'var(--surface-recessed)',
                    color:
                      'accent' in tab && tab.accent
                        ? 'var(--brand-tint-text)'
                        : 'var(--text-secondary)',
                  }}
                >
                  {tab.count}
                </span>
              )}
              {isActive && (
                <span
                  className="absolute inset-x-1 bottom-0 h-0.5 rounded-t"
                  style={{ backgroundColor: 'var(--brand-action)' }}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Active Config Panel */}
      <div className="min-w-0 p-3 sm:p-4">
        {activeTab === 'params' && (
          <KeyValueEditor
            title="Query Params"
            helperText="Append satu arah ke URL saat Execute ditekan (URL bar tidak di-parse balik ke tabel)."
            rows={queryParams}
            onChange={onQueryParamsChange}
            keyPlaceholder="key"
            valuePlaceholder="value atau {{variabel}}"
          />
        )}

        {activeTab === 'headers' && (
          <KeyValueEditor
            title="Request Headers"
            helperText="Mendukung template {{variabel}} dan token passthrough {{$.data.token}}. Header tidak disimpan ke localStorage."
            rows={headers}
            onChange={onHeadersChange}
            caseInsensitiveKeys
            presets={[
              {
                label: 'Content-Type: JSON',
                key: 'Content-Type',
                value: 'application/json',
                description: 'Payload JSON',
              },
              {
                label: 'Auth Bearer (Token Passthrough)',
                key: 'Authorization',
                value: 'Bearer {{$.data.token}}',
                description: 'Token sesi dari response sebelumnya',
              },
            ]}
            keyPlaceholder="Authorization"
            valuePlaceholder="Bearer {{$.data.token}}"
          />
        )}

        {activeTab === 'body' && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Request Body (JSON)
                </h2>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {method === 'GET'
                    ? 'Body diabaikan untuk method GET dan tidak dikirim oleh backend.'
                    : method === 'DELETE'
                      ? 'Body opsional untuk DELETE. Otomatis menyisipkan Content-Type: application/json bila belum diset.'
                      : 'Dikirim sebagai JSON ke target. Validasi sintaks berjalan real-time sebelum Execute.'}
                </p>
              </div>
              <button
                type="button"
                disabled={method === 'GET' || !bodyText.trim()}
                onClick={handleFormatJson}
                className="rounded-md border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-45"
                style={{
                  backgroundColor: 'var(--surface-recessed)',
                  borderColor: 'var(--border-control)',
                  color: 'var(--text-primary)',
                }}
              >
                Rapikan JSON
              </button>
            </div>

            <label htmlFor="json-body-textarea" className="sr-only">
              Editor Request Body JSON
            </label>
            <textarea
              id="json-body-textarea"
              disabled={method === 'GET'}
              value={bodyText}
              onChange={(e) => {
                setFormatNotice(null);
                onBodyTextChange(e.target.value);
              }}
              rows={7}
              spellCheck={false}
              placeholder={
                method === 'GET'
                  ? 'Method GET tidak mengirimkan request body.'
                  : '{\n  "username": "tester@example.com",\n  "password": ""\n}'
              }
              className="w-full rounded-md border p-3 font-mono text-xs leading-relaxed disabled:opacity-50"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: !jsonCheck.ok
                  ? 'var(--status-fail-border)'
                  : 'var(--border-control)',
                color: 'var(--text-primary)',
              }}
            />

            {!jsonCheck.ok && (
              <p role="alert" className="text-xs font-medium" style={{ color: 'var(--status-fail-fg)' }}>
                Sintaks JSON tidak valid: {jsonCheck.error}
              </p>
            )}
            {formatNotice && (
              <p role="status" className="text-xs" style={{ color: 'var(--status-warn-fg)' }}>
                {formatNotice}
              </p>
            )}
          </div>
        )}

        {activeTab === 'assertions' && (
          <AssertionConfigurator assertions={assertions} onChange={onAssertionsChange} />
        )}
      </div>
    </section>
  );
};
