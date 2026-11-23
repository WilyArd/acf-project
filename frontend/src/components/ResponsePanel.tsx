import React, { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Alert02Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  CodeIcon,
  Copy01Icon,
  Delete02Icon,
  Download01Icon,
  Key01Icon,
  ListChecksIcon,
  ListIcon,
  PlayIcon,
  RefreshIcon,
  Settings01Icon,
  ShieldCheckIcon,
  TextWrapIcon,
} from '@hugeicons/core-free-icons';
import type {
  AssertionDetail,
  ErrorPayload,
  ResultPayload,
  ValidationError,
} from '../types/api';
import { lookupDotPath } from '../lib/variables';
import { resolveResponseBody } from '../lib/jsonFormat';
import { JsonBodyViewer } from './JsonBodyViewer';

export type ResponseTab = 'assertions' | 'body' | 'headers';

interface ResponsePanelProps {
  isLoading: boolean;
  elapsedMs: number;
  onCancel: () => void;
  onRetry: () => void;
  result: ResultPayload | null;
  errorResult: ErrorPayload | null;
  validationError: ValidationError | null;
  clientError: string | null;
  networkError: string | null;
  unresolvedVars: string[];
  activeEnvName: string | null;
  defaultEnvName?: string | null;
  onOpenEnvEditor: () => void;
  onSelectDefaultEnv: () => void;
  capturedToken: { path: string; value: string } | null;
  onCaptureToken: (path: string, value: string) => void;
  onClearToken: () => void;
  onInsertBearerHeader: (path: string) => void;
  onSaveTokenToEnv?: (path: string, withBearerPrefix: boolean) => string | null;
  envTokenNeedsBearer?: boolean;
  autoSyncEnvToken?: boolean;
  onToggleAutoSyncEnvToken?: () => void;
  activeTab: ResponseTab;
  onActiveTabChange: (tab: ResponseTab) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatExpectedValue(detail: AssertionDetail): string {
  if (detail.operator === 'exists') return 'null (key harus ada)';
  if (detail.expected === null) return 'null';
  if (detail.expected === undefined) return '(kosong)';
  if (typeof detail.expected === 'object') {
    try {
      return JSON.stringify(detail.expected);
    } catch {
      return '[Object]';
    }
  }
  return detail.type === 'LATENCY' ? `${detail.expected} ms` : String(detail.expected);
}

function renderActualCell(detail: AssertionDetail): { text: string; badge?: string; tone: 'normal' | 'null' | 'missing' } {
  if (!detail.found) {
    return {
      text: 'Field tidak ada',
      badge: 'found: false',
      tone: 'missing',
    };
  }
  if (detail.actual === null) {
    return {
      text: 'null',
      badge: 'found: true',
      tone: 'null',
    };
  }
  if (typeof detail.actual === 'object') {
    const str = JSON.stringify(detail.actual);
    return {
      text: str.length > 72 ? `${str.slice(0, 69)}...` : str,
      tone: 'normal',
    };
  }
  return {
    text: detail.type === 'LATENCY' ? `${detail.actual} ms` : String(detail.actual),
    tone: 'normal',
  };
}

export const ResponsePanel: React.FC<ResponsePanelProps> = ({
  isLoading,
  elapsedMs,
  onCancel,
  onRetry,
  result,
  errorResult,
  validationError,
  clientError,
  networkError,
  unresolvedVars,
  activeEnvName,
  defaultEnvName = null,
  onOpenEnvEditor,
  onSelectDefaultEnv,
  capturedToken,
  onCaptureToken,
  onClearToken,
  onInsertBearerHeader,
  onSaveTokenToEnv,
  envTokenNeedsBearer = true,
  autoSyncEnvToken = true,
  onToggleAutoSyncEnvToken,
  activeTab,
  onActiveTabChange,
}) => {
  const [bodyMode, setBodyMode] = useState<'pretty' | 'raw'>('pretty');
  const [wrapLines, setWrapLines] = useState(true);
  const [copiedBody, setCopiedBody] = useState(false);
  const [tokenPathInput, setTokenPathInput] = useState('data.token');
  const [tokenExtractMsg, setTokenExtractMsg] = useState<string | null>(null);

  useEffect(() => {
    if (capturedToken?.path) {
      setTokenPathInput(capturedToken.path);
    }
  }, [capturedToken?.path]);

  const resolvedBody = useMemo(
    () => (result ? resolveResponseBody(result.rawResponse.body) : resolveResponseBody(undefined)),
    [result],
  );

  const formattedBody =
    bodyMode === 'pretty' && resolvedBody.isJson ? resolvedBody.prettyText : resolvedBody.rawText;

  const bodyIsObject = resolvedBody.isJson;

  const handleCopyBody = async () => {
    if (!formattedBody) return;
    try {
      await navigator.clipboard.writeText(formattedBody);
      setCopiedBody(true);
      setTimeout(() => setCopiedBody(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleExtractToken = () => {
    setTokenExtractMsg(null);
    if (!result || !bodyIsObject) {
      setTokenExtractMsg('Response body bukan JSON object yang dapat diekstrak.');
      return;
    }
    const cleanPath = tokenPathInput.trim().replace(/^\$\./, '');
    const lookup = lookupDotPath(resolvedBody.parsed, cleanPath);
    if (!lookup.found) {
      setTokenExtractMsg(`Path "${cleanPath}" tidak ditemukan pada response body.`);
      return;
    }
    if (lookup.value === null || lookup.value === undefined || typeof lookup.value === 'object') {
      setTokenExtractMsg(`Nilai pada "${cleanPath}" bukan string/angka primitif.`);
      return;
    }
    onCaptureToken(cleanPath, String(lookup.value));
    setTokenExtractMsg(`Token dari "{{$.${cleanPath}}}" disimpan di memori sesi.`);
  };

  return (
    <section
      aria-label="Hasil Pengujian dan Response Viewer"
      className="flex min-h-[380px] min-w-0 flex-1 flex-col"
      style={{ backgroundColor: 'var(--surface-canvas)' }}
    >
      {/* Session Token Bar when result panel is empty/error so user can always revoke active token */}
      {capturedToken && (!result || isLoading) && (
        <div
          className="m-4 mb-0 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
          style={{
            backgroundColor: 'var(--brand-tint)',
            borderColor: 'var(--brand-tint-border)',
            color: 'var(--brand-tint-text)',
          }}
        >
          <span className="font-mono text-[11px]">
            Token sesi aktif: {`{{$.${capturedToken.path}}}`}
          </span>
          <button
            type="button"
            onClick={() => {
              onClearToken();
              setTokenExtractMsg('Token passthrough sesi dihapus.');
            }}
            className="rounded border px-2 py-0.5 text-[11px] font-semibold"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-control)',
              color: 'var(--status-fail-fg)',
            }}
          >
            Hapus Token Sesi
          </button>
        </div>
      )}

      {/* Pre-Flight Validation Error Banner (400 / 403 / 429), strictly separate from Verdict */}
      {validationError && (
        <div
          role="alert"
          className="m-4 mb-0 rounded-md border p-3.5"
          style={{
            backgroundColor: 'var(--status-warn-bg)',
            borderColor: 'var(--status-warn-border)',
            color: 'var(--status-warn-fg)',
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded px-2 py-0.5 font-mono text-[11px] font-bold"
              style={{
                backgroundColor: 'var(--surface-canvas)',
                color: 'var(--status-warn-fg)',
                border: '1px solid var(--status-warn-border)',
              }}
            >
              DITOLAK PRA-EKSEKUSI {validationError.httpStatus ? `HTTP ${validationError.httpStatus}` : ''}
            </span>
            <span className="font-mono text-xs font-bold">{validationError.code}</span>
            {validationError.field && (
              <span className="font-mono text-xs opacity-85">
                field: {validationError.field}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs font-medium">{validationError.message}</p>
          <p className="mt-1 text-[11px] opacity-90">
            Request belum pernah dikirim ke server target. Perbaiki input di atas lalu klik Execute kembali.
          </p>
        </div>
      )}

      {/* Client Pre-Check or Backend Unreachable Banner */}
      {(clientError || networkError) && !validationError && (
        <div
          role="alert"
          className="m-4 mb-0 rounded-md border p-3.5"
          style={{
            backgroundColor: 'var(--status-fail-bg)',
            borderColor: 'var(--status-fail-border)',
            color: 'var(--status-fail-fg)',
          }}
        >
          <p className="text-xs font-bold">
            {networkError ? 'Backend Proxy Tidak Terjangkau' : 'Validasi Input Sebelum Eksekusi'}
          </p>
          <p className="mt-1 text-xs">{networkError ?? clientError}</p>
        </div>
      )}

      {/* Unresolved Variable Guard */}
      {unresolvedVars.length > 0 && !isLoading && (
        <div
          role="status"
          className="m-4 mb-0 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          style={{
            backgroundColor: 'var(--status-fail-bg)',
            borderColor: 'var(--status-fail-border)',
            color: 'var(--status-fail-fg)',
          }}
        >
          <div className="space-y-0.5 text-xs">
            <p className="font-semibold">
              Variabel belum terdefinisi: {unresolvedVars.map((v) => `{{${v}}}`).join(', ')}
            </p>
            <p className="text-[11px] opacity-90">
              Environment aktif saat ini: {activeEnvName ?? 'No Environment'}. Pilih Environment atau definisikan nilainya sebelum Execute.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!activeEnvName && (
              <button
                type="button"
                onClick={onSelectDefaultEnv}
                className="rounded-md px-3 py-1.5 text-xs font-bold"
                style={{
                  backgroundColor: 'var(--brand-action)',
                  color: 'var(--brand-on-action)',
                }}
              >
                {defaultEnvName ? `Aktifkan ${defaultEnvName}` : '+ Buat Environment'}
              </button>
            )}
            <button
              type="button"
              onClick={onOpenEnvEditor}
              className="rounded-md border px-3 py-1.5 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--surface-canvas)',
                borderColor: 'var(--border-control)',
                color: 'var(--text-primary)',
              }}
            >
              Buka Editor Environment
            </button>
          </div>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div
          role="status"
          aria-live="polite"
          className="m-4 flex flex-1 flex-col items-center justify-center rounded-md border p-8 text-center"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <span
            aria-hidden="true"
            className="h-7 w-7 animate-spin rounded-full border-2 border-t-transparent"
            style={{
              borderColor: 'var(--brand-action)',
              borderTopColor: 'transparent',
            }}
          />
          <p className="mt-3 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Loading...
          </p>
          <p className="mt-1 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
            {(elapsedMs / 1000).toFixed(1)}s
          </p>
          <button
            type="button"
            onClick={onCancel}
            className="mt-4 rounded-md border px-4 py-2 text-xs font-semibold"
            style={{
              backgroundColor: 'var(--surface-recessed)',
              borderColor: 'var(--border-control)',
              color: 'var(--text-primary)',
            }}
          >
            Batalkan Request
          </button>
        </div>
      )}

      {/* ERROR Verdict State (Target Unreachable / Timeout 15s / DNS Failure) */}
      {!isLoading && errorResult && (
        <div className="flex flex-1 flex-col">
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-hairline)',
            }}
          >
            <div className="flex items-center gap-2.5">
              <span
                className="rounded border px-2 py-0.5 text-[11px] font-bold"
                style={{
                  backgroundColor: 'var(--status-error-bg)',
                  borderColor: 'var(--status-error-border)',
                  color: 'var(--status-error-fg)',
                }}
              >
                ERROR
              </span>
              <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                Request Error: Target tidak dapat dijangkau
              </span>
            </div>
            <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
              {new Date(errorResult.executedAt).toLocaleTimeString('id-ID')}
            </span>
          </div>

          <div className="p-4">
            <div
              className="rounded-md border p-4"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--status-error-border)',
              }}
            >
              <p className="font-mono text-xs font-bold" style={{ color: 'var(--status-warn-fg)' }}>
                {errorResult.errorReason}
              </p>
              <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                Seluruh assertion tidak dievaluasi karena server target tidak mengembalikan respons HTTP. Periksa alamat host, koneksi jaringan/VPN, atau ganti Environment aktif.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-md px-4 py-2 text-xs font-bold"
                  style={{
                    backgroundColor: 'var(--brand-action)',
                    color: 'var(--brand-on-action)',
                  }}
                >
                  Coba Execute Lagi
                </button>
                <button
                  type="button"
                  onClick={onOpenEnvEditor}
                  className="rounded-md border px-3 py-2 text-xs font-semibold"
                  style={{
                    backgroundColor: 'var(--surface-recessed)',
                    borderColor: 'var(--border-control)',
                    color: 'var(--text-primary)',
                  }}
                >
                  Periksa Environment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PASS / FAIL Result View */}
      {!isLoading && result && (
        <div className="flex flex-1 flex-col">
          {/* Sticky Verdict & Info Panel Strip */}
          <div
            className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-hairline)',
            }}
          >
            <div className="flex flex-wrap items-center gap-2.5">
              {result.overallStatus === 'PASS' ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded border px-2.5 py-0.5 text-[11px] font-bold"
                  style={{
                    backgroundColor: 'var(--status-pass-bg)',
                    borderColor: 'var(--status-pass-border)',
                    color: 'var(--status-pass-fg)',
                  }}
                >
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} strokeWidth={2} />
                  <span>PASSED</span>
                </span>
              ) : (
                <span
                  className="inline-flex items-center gap-1.5 rounded border px-2.5 py-0.5 text-[11px] font-bold"
                  style={{
                    backgroundColor: 'var(--status-fail-bg)',
                    borderColor: 'var(--status-fail-border)',
                    color: 'var(--status-fail-fg)',
                  }}
                >
                  <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={2} />
                  <span>FAILED ({result.failedCount} dari {result.totalAssertions} assertion gagal)</span>
                </span>
              )}

              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                {result.passedCount}/{result.totalAssertions} terpenuhi
              </span>
            </div>

            {/* Info Panel: Status Code, Latency, Body Size (never a separate tab) */}
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
              <span
                className="font-bold"
                style={{
                  color:
                    result.rawResponse.statusCode >= 200 && result.rawResponse.statusCode < 300
                      ? 'var(--status-pass-fg)'
                      : result.rawResponse.statusCode >= 400
                        ? 'var(--status-fail-fg)'
                        : 'var(--status-warn-fg)',
                }}
              >
                HTTP {result.rawResponse.statusCode}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {result.rawResponse.responseTimeMs} ms
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {formatBytes(result.rawResponse.bodySizeBytes)}
              </span>
              {capturedToken && (
                <span
                  className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px]"
                  style={{
                    backgroundColor: 'var(--brand-tint)',
                    borderColor: 'var(--brand-tint-border)',
                    color: 'var(--brand-tint-text)',
                  }}
                >
                  <span>Token sesi: {`{{$.${capturedToken.path}}}`}</span>
                  <button
                    type="button"
                    onClick={() => {
                      onClearToken();
                      setTokenExtractMsg('Token passthrough sesi dihapus.');
                    }}
                    aria-label="Hapus token sesi"
                    className="font-sans text-[10px] font-bold underline"
                    style={{ color: 'var(--status-fail-fg)' }}
                  >
                    Hapus
                  </button>
                </span>
              )}
            </div>
          </div>

          {/* 2MB Truncation Warning */}
          {result.rawResponse.truncated && (
            <div
              role="alert"
              className="mx-4 mt-3 rounded-md border px-3 py-2 text-xs font-medium"
              style={{
                backgroundColor: 'var(--status-warn-bg)',
                borderColor: 'var(--status-warn-border)',
                color: 'var(--status-warn-fg)',
              }}
            >
              Peringatan: Response body dipotong pada batas 2 MB sehingga tidak diparse sebagai JSON dan assertion BODY_JSON_PATH otomatis FAIL.
            </div>
          )}

          {/* Response Sub-tabs + Token Passthrough Quick Bar */}
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b px-4"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <div role="tablist" aria-label="Tab hasil dan response" className="flex items-center gap-1">
              {(
                [
                  {
                    id: 'assertions',
                    label: `Hasil Assertion (${result.passedCount}/${result.totalAssertions})`,
                    icon: ListChecksIcon,
                  },
                  { id: 'body', label: 'Body', icon: CodeIcon },
                  {
                    id: 'headers',
                    label: `Headers (${Object.keys(result.rawResponse.headers).length})`,
                    icon: ListIcon,
                  },
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
                    className="relative inline-flex min-h-10 items-center gap-1.5 px-3 text-xs transition-colors"
                    style={{
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    <HugeiconsIcon icon={tab.icon} size={13} strokeWidth={1.8} />
                    <span>{tab.label}</span>
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

            {/* Inline Token Passthrough Extractor (memory-only) */}
            {bodyIsObject && (
              <div className="flex flex-wrap items-center gap-1.5 py-1.5">
                <label htmlFor="token-extract-path" className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Passthrough path:
                </label>
                <input
                  id="token-extract-path"
                  type="text"
                  value={tokenPathInput}
                  onChange={(e) => setTokenPathInput(e.target.value)}
                  placeholder="data.token"
                  className="h-7 w-28 rounded border bg-transparent px-2 font-mono text-[11px]"
                  style={{
                    borderColor: 'var(--border-control)',
                    color: 'var(--text-primary)',
                  }}
                />
                <button
                  type="button"
                  onClick={handleExtractToken}
                  className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] font-semibold"
                  style={{
                    backgroundColor: 'var(--brand-tint)',
                    borderColor: 'var(--brand-tint-border)',
                    color: 'var(--brand-tint-text)',
                  }}
                >
                  <HugeiconsIcon icon={Key01Icon} size={12} strokeWidth={1.8} />
                  <span>Ekstrak Token</span>
                </button>
                {capturedToken && (
                  <>
                    <button
                      type="button"
                      onClick={() => onInsertBearerHeader(capturedToken.path)}
                      className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] font-semibold"
                      style={{
                        backgroundColor: 'var(--surface-recessed)',
                        borderColor: 'var(--border-control)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <HugeiconsIcon icon={ShieldCheckIcon} size={12} strokeWidth={1.8} />
                      <span>Pasang ke Bearer</span>
                    </button>
                    {onSaveTokenToEnv && (
                      <button
                        type="button"
                        onClick={() => {
                          const savedVar = onSaveTokenToEnv(
                            capturedToken.path,
                            Boolean(envTokenNeedsBearer),
                          );
                          if (savedVar) {
                            setTokenExtractMsg(
                              `Token disimpan ke Environment ({{${savedVar}}})${envTokenNeedsBearer ? ' dengan prefix Bearer.' : '.'}`,
                            );
                          }
                        }}
                        title="Simpan token ini langsung ke variabel Environment aktif ({{token}})"
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] font-semibold"
                        style={{
                          backgroundColor: 'var(--status-pass-bg)',
                          borderColor: 'var(--status-pass-border)',
                          color: 'var(--status-pass-fg)',
                        }}
                      >
                        <HugeiconsIcon icon={Download01Icon} size={12} strokeWidth={1.8} />
                        <span>{envTokenNeedsBearer ? 'Simpan ke Env (Bearer)' : 'Simpan ke Env'}</span>
                      </button>
                    )}
                    {onToggleAutoSyncEnvToken && (
                      <button
                        type="button"
                        aria-pressed={autoSyncEnvToken}
                        onClick={onToggleAutoSyncEnvToken}
                        title="Otomatis perbarui variabel {{token}} pada Environment aktif setiap kali request login sukses (seperti pm.environment.set di Postman)"
                        className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] font-semibold"
                        style={
                          autoSyncEnvToken
                            ? {
                                backgroundColor: 'var(--brand-tint)',
                                borderColor: 'var(--brand-tint-border)',
                                color: 'var(--brand-tint-text)',
                              }
                            : {
                                backgroundColor: 'var(--surface-recessed)',
                                borderColor: 'var(--border-hairline)',
                                color: 'var(--text-muted)',
                              }
                        }
                      >
                        <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.8} />
                        <span>Auto-Sync Env: {autoSyncEnvToken ? 'ON' : 'OFF'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onClearToken();
                        setTokenExtractMsg('Token passthrough sesi dihapus.');
                      }}
                      className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] font-medium"
                      style={{
                        borderColor: 'var(--border-hairline)',
                        color: 'var(--status-fail-fg)',
                      }}
                    >
                      <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.8} />
                      <span>Hapus</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {tokenExtractMsg && (
            <p
              role="status"
              className="mx-4 mt-2 text-[11px] font-medium"
              style={{ color: 'var(--brand-tint-text)' }}
            >
              {tokenExtractMsg}
            </p>
          )}

          {/* Active Response Content */}
          <div className="flex-1 p-4">
            {activeTab === 'assertions' && (
              <div
                className="overflow-x-auto rounded-md border"
                style={{
                  backgroundColor: 'var(--surface-elevated)',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                <table className="w-full min-w-[680px] border-collapse text-left text-xs">
                  <thead>
                    <tr
                      className="border-b"
                      style={{
                        backgroundColor: 'var(--surface-recessed)',
                        borderColor: 'var(--border-hairline)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      <th className="px-3 py-2 font-semibold">Type</th>
                      <th className="px-3 py-2 font-semibold">Target/Field</th>
                      <th className="px-3 py-2 font-semibold">Operator</th>
                      <th className="px-3 py-2 font-semibold">Expected</th>
                      <th className="px-3 py-2 font-semibold">Actual</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.assertionDetails.map((detail, idx) => {
                      const actualInfo = renderActualCell(detail);
                      return (
                        <tr
                          key={`${detail.type}_${detail.target ?? 'none'}_${idx}`}
                          className={idx < result.assertionDetails.length - 1 ? 'border-b' : ''}
                          style={{ borderColor: 'var(--border-hairline)' }}
                        >
                          <td
                            className="px-3 py-2.5 font-mono text-[11px] font-semibold"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {detail.type}
                          </td>
                          <td
                            className="px-3 py-2.5 font-mono text-xs"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {detail.type === 'STATUS_CODE' || detail.type === 'LATENCY'
                              ? '—'
                              : detail.target ?? '—'}
                          </td>
                          <td
                            className="px-3 py-2.5 font-mono text-xs"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {detail.operator}
                          </td>
                          <td
                            className="px-3 py-2.5 font-mono text-xs"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {formatExpectedValue(detail)}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                style={{
                                  color:
                                    actualInfo.tone === 'missing'
                                      ? 'var(--status-fail-fg)'
                                      : actualInfo.tone === 'null'
                                        ? 'var(--status-warn-fg)'
                                        : 'var(--text-primary)',
                                  fontStyle: actualInfo.tone === 'missing' ? 'italic' : 'normal',
                                }}
                              >
                                {actualInfo.text}
                              </span>
                              {actualInfo.badge && (
                                <span
                                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                                  style={
                                    actualInfo.tone === 'missing'
                                      ? {
                                          backgroundColor: 'var(--status-fail-bg)',
                                          color: 'var(--status-fail-fg)',
                                        }
                                      : {
                                          backgroundColor: 'var(--status-warn-bg)',
                                          color: 'var(--status-warn-fg)',
                                        }
                                  }
                                >
                                  {actualInfo.badge}
                                </span>
                              )}
                            </div>
                            {detail.reason && (
                              <p
                                className="mt-1 font-sans text-[11px]"
                                style={{ color: 'var(--status-fail-fg)' }}
                              >
                                {detail.reason}
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <span
                              className="inline-block rounded px-2 py-0.5 text-[10px] font-bold"
                              style={
                                detail.status === 'PASS'
                                  ? {
                                      backgroundColor: 'var(--status-pass-bg)',
                                      color: 'var(--status-pass-fg)',
                                    }
                                  : {
                                      backgroundColor: 'var(--status-fail-bg)',
                                      color: 'var(--status-fail-fg)',
                                    }
                              }
                            >
                              {detail.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'body' && (
              <div
                className="overflow-hidden rounded-md border"
                style={{
                  backgroundColor: 'var(--surface-elevated)',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                <div
                  className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
                  style={{
                    backgroundColor: 'var(--surface-recessed)',
                    borderColor: 'var(--border-hairline)',
                  }}
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      disabled={!bodyIsObject}
                      onClick={() => setBodyMode('pretty')}
                      className="rounded px-2 py-0.5 font-semibold disabled:opacity-45"
                      style={
                        bodyMode === 'pretty'
                          ? { backgroundColor: 'var(--surface-canvas)', color: 'var(--text-primary)' }
                          : { color: 'var(--text-secondary)' }
                      }
                    >
                      Pretty JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => setBodyMode('raw')}
                      className="rounded px-2 py-0.5 font-semibold"
                      style={
                        bodyMode === 'raw'
                          ? { backgroundColor: 'var(--surface-canvas)', color: 'var(--text-primary)' }
                          : { color: 'var(--text-secondary)' }
                      }
                    >
                      Raw
                    </button>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {bodyIsObject ? 'application/json' : 'raw text'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setWrapLines((w) => !w)}
                      aria-pressed={wrapLines}
                      title="Bungkus baris panjang agar tidak perlu scroll menyamping"
                      className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold"
                      style={
                        wrapLines
                          ? {
                              backgroundColor: 'var(--surface-canvas)',
                              borderColor: 'var(--border-control)',
                              color: 'var(--text-primary)',
                            }
                          : {
                              backgroundColor: 'transparent',
                              borderColor: 'var(--border-hairline)',
                              color: 'var(--text-muted)',
                            }
                      }
                    >
                      <HugeiconsIcon icon={TextWrapIcon} size={12} strokeWidth={1.8} />
                      <span>Wrap: {wrapLines ? 'ON' : 'OFF'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleCopyBody}
                      className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold"
                      style={{ color: 'var(--brand-tint-text)' }}
                    >
                      <HugeiconsIcon
                        icon={copiedBody ? CheckIcon : Copy01Icon}
                        size={12}
                        strokeWidth={1.8}
                      />
                      <span>{copiedBody ? 'Tersalin' : 'Salin Response'}</span>
                    </button>
                  </div>
                </div>

                {bodyMode === 'pretty' && bodyIsObject ? (
                  <JsonBodyViewer prettyText={resolvedBody.prettyText} wrapLines={wrapLines} />
                ) : (
                  <pre
                    className={`max-h-[440px] p-3.5 font-mono text-xs leading-relaxed ${
                      wrapLines
                        ? 'overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-all'
                        : 'overflow-auto whitespace-pre'
                    }`}
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <code>{formattedBody || '(Body response kosong)'}</code>
                  </pre>
                )}
              </div>
            )}

            {activeTab === 'headers' && (
              <div
                className="overflow-x-auto rounded-md border"
                style={{
                  backgroundColor: 'var(--surface-elevated)',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                <table className="w-full min-w-[460px] border-collapse text-left text-xs">
                  <thead>
                    <tr
                      className="border-b"
                      style={{
                        backgroundColor: 'var(--surface-recessed)',
                        borderColor: 'var(--border-hairline)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      <th className="w-1/3 px-3 py-2 font-semibold">HEADER</th>
                      <th className="px-3 py-2 font-semibold">VALUE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(result.rawResponse.headers).length === 0 ? (
                      <tr>
                        <td
                          colSpan={2}
                          className="px-3 py-4 text-center text-xs"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          Tidak ada response header yang dikembalikan.
                        </td>
                      </tr>
                    ) : (
                      Object.entries(result.rawResponse.headers).map(([key, val], idx, arr) => (
                        <tr
                          key={key}
                          className={idx < arr.length - 1 ? 'border-b' : ''}
                          style={{ borderColor: 'var(--border-hairline)' }}
                        >
                          <td
                            className="px-3 py-2 font-mono font-semibold"
                            style={{ color: 'var(--text-primary)' }}
                          >
                            {key}
                          </td>
                          <td
                            className="break-all px-3 py-2 font-mono"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            {val}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Initial Empty State (only when no result, no error, and no validation/client/network banner) */}
      {!isLoading &&
        !result &&
        !errorResult &&
        !validationError &&
        !clientError &&
        !networkError && (
        <div
          className="m-4 flex flex-1 flex-col items-center justify-center rounded-md border p-8 text-center"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Siap Menjalankan Pengujian API
          </h2>
          <p
            className="mt-1.5 max-w-lg text-xs leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            Pastikan Environment aktif sudah dipilih (jika memakai {'{{variabel}}'}), atur minimal 1 expected result pada tab Assertions, lalu tekan tombol Execute untuk mendapatkan verdict PASS / FAIL otomatis.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-bold"
              style={{
                backgroundColor: 'var(--brand-action)',
                color: 'var(--brand-on-action)',
              }}
            >
              <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={2} />
              <span>Execute Sekarang</span>
            </button>
            <button
              type="button"
              onClick={onOpenEnvEditor}
              className="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--surface-recessed)',
                borderColor: 'var(--border-control)',
                color: 'var(--text-primary)',
              }}
            >
              <HugeiconsIcon icon={Settings01Icon} size={13} strokeWidth={1.8} />
              <span>Kelola Environment</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
