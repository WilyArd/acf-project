import React from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  Delete02Icon,
  ListOrderedIcon,
  PlayIcon,
  StopIcon,
} from '@hugeicons/core-free-icons';
import type { HttpMethod } from '../types/api';
import { MAX_BATCH_REQUESTS, type BatchStepResult } from '../lib/batchRunner';

interface BatchRunnerPanelProps {
  steps: BatchStepResult[];
  activeEnvName: string | null;
  isRunning: boolean;
  stopOnFailure: boolean;
  onStopOnFailureChange: (next: boolean) => void;
  delayMs: number;
  onDelayMsChange: (next: number) => void;
  rateLimited: boolean;
  aborted: boolean;
  onRun: () => void;
  onCancel: () => void;
  onMoveStep: (index: number, delta: -1 | 1) => void;
  onRemoveStep: (itemId: string) => void;
  onClearQueue: () => void;
  onInspectStep: (itemId: string) => void;
  onBackToWorkbench: () => void;
}

const METHOD_COLOR_VAR: Record<HttpMethod, string> = {
  GET: 'var(--method-get)',
  POST: 'var(--method-post)',
  PUT: 'var(--method-put)',
  PATCH: 'var(--method-patch)',
  DELETE: 'var(--method-delete)',
};

function statusBadgeMeta(status: BatchStepResult['status'], statusCode?: number) {
  switch (status) {
    case 'running':
      return {
        label: 'BERJALAN...',
        bg: 'var(--brand-tint)',
        border: 'var(--brand-tint-border)',
        fg: 'var(--brand-tint-text)',
      };
    case 'pass':
      return {
        label: statusCode ? `PASS · ${statusCode}` : 'PASS',
        bg: 'var(--status-pass-bg)',
        border: 'var(--status-pass-border)',
        fg: 'var(--status-pass-fg)',
      };
    case 'fail':
      return {
        label: statusCode ? `FAIL · ${statusCode}` : 'FAIL',
        bg: 'var(--status-fail-bg)',
        border: 'var(--status-fail-border)',
        fg: 'var(--status-fail-fg)',
      };
    case 'error':
      return {
        label: 'ERROR',
        bg: 'var(--status-error-bg)',
        border: 'var(--status-error-border)',
        fg: 'var(--status-error-fg)',
      };
    case 'validation':
      return {
        label: statusCode ? `DITOLAK · ${statusCode}` : 'VALIDASI',
        bg: 'var(--status-warn-bg)',
        border: 'var(--status-warn-border)',
        fg: 'var(--status-warn-fg)',
      };
    case 'skipped':
      return {
        label: 'DILEWATI',
        bg: 'var(--surface-recessed)',
        border: 'var(--border-hairline)',
        fg: 'var(--text-muted)',
      };
    case 'aborted':
      return {
        label: 'DIBATALKAN',
        bg: 'var(--surface-recessed)',
        border: 'var(--border-hairline)',
        fg: 'var(--text-muted)',
      };
    default:
      return {
        label: 'ANTRI',
        bg: 'var(--surface-recessed)',
        border: 'var(--border-hairline)',
        fg: 'var(--text-secondary)',
      };
  }
}

export const BatchRunnerPanel: React.FC<BatchRunnerPanelProps> = ({
  steps,
  activeEnvName,
  isRunning,
  stopOnFailure,
  onStopOnFailureChange,
  delayMs,
  onDelayMsChange,
  rateLimited,
  aborted,
  onRun,
  onCancel,
  onMoveStep,
  onRemoveStep,
  onClearQueue,
  onInspectStep,
  onBackToWorkbench,
}) => {
  const mutatingCount = steps.filter((s) => s.method !== 'GET').length;
  const completedCount = steps.filter((s) => s.status !== 'queued' && s.status !== 'running').length;
  const passCount = steps.filter((s) => s.status === 'pass').length;
  const failCount = steps.filter((s) => s.status === 'fail').length;
  const errorCount = steps.filter((s) => s.status === 'error' || s.status === 'validation').length;
  const skippedCount = steps.filter((s) => s.status === 'skipped' || s.status === 'aborted').length;
  const progressPct = steps.length > 0 ? Math.round((completedCount / steps.length) * 100) : 0;

  return (
    <section
      aria-label="Eksekusi Berurutan (Batch Runner)"
      className="flex min-h-full flex-1 flex-col"
      style={{ backgroundColor: 'var(--surface-canvas)' }}
    >
      {/* Top Strip */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2"
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold"
            style={{
              backgroundColor: 'var(--brand-tint)',
              color: 'var(--brand-tint-text)',
            }}
          >
            <HugeiconsIcon icon={ListOrderedIcon} size={11} strokeWidth={2} />
            <span>SEQUENTIAL</span>
          </span>
          <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Eksekusi Berurutan ({steps.length} / {MAX_BATCH_REQUESTS} request)
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            · Env: {activeEnvName ?? 'No Environment'}
          </span>
        </div>

        <button
          type="button"
          onClick={onBackToWorkbench}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-semibold"
          style={{
            backgroundColor: 'var(--surface-recessed)',
            borderColor: 'var(--border-control)',
            color: 'var(--text-primary)',
          }}
        >
          <HugeiconsIcon icon={ChevronLeftIcon} size={13} strokeWidth={2} />
          <span>Kembali ke Request</span>
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        {/* Controls Card */}
        <div
          className="space-y-3 rounded-md border p-4"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="inline-flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={stopOnFailure}
                  disabled={isRunning}
                  onChange={(e) => onStopOnFailureChange(e.target.checked)}
                  className="h-4 w-4 accent-[var(--brand-action)]"
                />
                <span style={{ color: 'var(--text-primary)' }}>Berhenti jika gagal</span>
              </label>

              <label className="inline-flex items-center gap-2">
                <span style={{ color: 'var(--text-secondary)' }}>Jeda antar request (ms):</span>
                <input
                  type="number"
                  min={0}
                  max={5000}
                  step={50}
                  disabled={isRunning}
                  value={delayMs}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    onDelayMsChange(Number.isFinite(parsed) ? Math.max(0, Math.min(5000, parsed)) : 0);
                  }}
                  className="h-8 w-20 rounded border bg-transparent px-2 font-mono text-xs"
                  style={{
                    borderColor: 'var(--border-control)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!isRunning && steps.length > 0 && (
                <button
                  type="button"
                  onClick={onClearQueue}
                  className="rounded-md border px-3 py-1.5 text-xs font-semibold"
                  style={{
                    backgroundColor: 'var(--surface-recessed)',
                    borderColor: 'var(--border-control)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Kosongkan Antrean
                </button>
              )}

              {isRunning ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className="inline-flex items-center gap-1.5 rounded-md border px-4 py-1.5 text-xs font-bold"
                  style={{
                    backgroundColor: 'var(--status-fail-bg)',
                    borderColor: 'var(--status-fail-border)',
                    color: 'var(--status-fail-fg)',
                  }}
                >
                  <HugeiconsIcon icon={StopIcon} size={13} strokeWidth={2} />
                  <span>Batalkan Eksekusi</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={steps.length === 0}
                  onClick={onRun}
                  className="inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-bold disabled:opacity-45"
                  style={{
                    backgroundColor: 'var(--brand-action)',
                    color: 'var(--brand-on-action)',
                  }}
                >
                  <HugeiconsIcon icon={PlayIcon} size={13} strokeWidth={2} />
                  <span>Jalankan Berurutan ({steps.length})</span>
                </button>
              )}
            </div>
          </div>

          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Request dijalankan satu per satu sesuai nomor urut. Token dari respons <span className="font-mono">2xx</span> otomatis diteruskan ke langkah berikutnya pada origin yang sama (<span className="font-mono">{'{{$.data.token}}'}</span>). Item yang belum pernah dibuka menggunakan assertion default <span className="font-mono">STATUS_CODE = 200</span>.
          </p>

          {mutatingCount > 0 && (
            <div
              role="status"
              className="rounded-md border px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--status-warn-bg)',
                borderColor: 'var(--status-warn-border)',
                color: 'var(--status-warn-fg)',
              }}
            >
              Perhatian: Antrean memuat <strong>{mutatingCount} request mutasi</strong> (POST/PUT/PATCH/DELETE). Pastikan Environment aktif sesuai sebelum menjalankan.
            </div>
          )}

          {rateLimited && (
            <div
              role="alert"
              className="rounded-md border px-3 py-2 text-xs font-medium"
              style={{
                backgroundColor: 'var(--status-fail-bg)',
                borderColor: 'var(--status-fail-border)',
                color: 'var(--status-fail-fg)',
              }}
            >
              Eksekusi dihentikan otomatis karena mencapai batas rate limit backend (HTTP 429 — 30 request/menit). Tunggu sebentar sebelum menjalankan ulang.
            </div>
          )}

          {aborted && !rateLimited && (
            <div
              role="status"
              className="rounded-md border px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--surface-recessed)',
                borderColor: 'var(--border-control)',
                color: 'var(--text-secondary)',
              }}
            >
              Eksekusi berurutan dibatalkan sebelum seluruh antrean selesai.
            </div>
          )}

          {/* Progress bar + summary */}
          {steps.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Progres: {completedCount} / {steps.length} ({progressPct}%)
                </span>
                <div className="flex flex-wrap items-center gap-2 font-mono">
                  <span style={{ color: 'var(--status-pass-fg)' }}>PASS: {passCount}</span>
                  <span style={{ color: 'var(--status-fail-fg)' }}>FAIL: {failCount}</span>
                  <span style={{ color: 'var(--status-warn-fg)' }}>ERR/VAL: {errorCount}</span>
                  {skippedCount > 0 && (
                    <span style={{ color: 'var(--text-muted)' }}>SKIP: {skippedCount}</span>
                  )}
                </div>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full"
                style={{ backgroundColor: 'var(--surface-recessed)' }}
              >
                <div
                  className="h-full transition-all duration-200"
                  style={{
                    width: `${progressPct}%`,
                    backgroundColor:
                      failCount > 0 || errorCount > 0
                        ? 'var(--status-fail-fg)'
                        : 'var(--status-pass-fg)',
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Ordered Queue / Results List */}
        {steps.length === 0 ? (
          <div
            className="rounded-md border p-6 text-center text-xs"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-hairline)',
              color: 'var(--text-secondary)',
            }}
          >
            Belum ada request yang dicentang. Aktifkan <strong>Pilih Banyak</strong> di tab Collections pada Sidebar untuk memilih hingga {MAX_BATCH_REQUESTS} endpoint.
          </div>
        ) : (
          <div
            className="divide-y overflow-hidden rounded-md border"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-hairline)',
            }}
          >
            {steps.map((step, idx) => {
              const badge = statusBadgeMeta(step.status, step.statusCode);
              const failureDetail =
                step.clientError ??
                step.validationError?.message ??
                step.networkError ??
                step.errorResult?.errorReason ??
                step.skipReason ??
                null;

              return (
                <div
                  key={step.itemId}
                  className="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                  style={{
                    backgroundColor:
                      step.status === 'running' ? 'var(--surface-recessed)' : 'transparent',
                  }}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <span
                      className="mt-0.5 inline-flex shrink-0 items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold"
                      style={{
                        backgroundColor: 'var(--brand-tint)',
                        borderColor: 'var(--brand-tint-border)',
                        color: 'var(--brand-tint-text)',
                      }}
                    >
                      #{idx + 1}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="font-mono text-[11px] font-bold"
                          style={{ color: METHOD_COLOR_VAR[step.method] }}
                        >
                          {step.method}
                        </span>
                        <button
                          type="button"
                          onClick={() => onInspectStep(step.itemId)}
                          className="truncate text-left text-xs font-semibold hover:underline"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {step.name}
                        </button>
                        {step.folderPath.length > 0 && (
                          <span className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {step.folderPath.join(' / ')}
                          </span>
                        )}
                      </div>

                      <p
                        className="mt-0.5 truncate font-mono text-[11px]"
                        style={{ color: 'var(--text-secondary)' }}
                        title={step.urlTemplate}
                      >
                        {step.urlTemplate || '(URL kosong)'}
                      </p>

                      {failureDetail && (
                        <p
                          className="mt-1 text-[11px]"
                          style={{
                            color:
                              step.status === 'skipped' || step.status === 'aborted'
                                ? 'var(--text-muted)'
                                : 'var(--status-fail-fg)',
                          }}
                        >
                          {failureDetail}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Right: Status + Metrics + Reorder Controls */}
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {step.durationMs !== undefined && (
                      <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {step.durationMs} ms
                      </span>
                    )}
                    {step.totalAssertions > 0 && (
                      <span className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {step.passedCount}/{step.totalAssertions}
                      </span>
                    )}

                    <span
                      className="rounded border px-2 py-0.5 font-mono text-[10px] font-bold"
                      style={{
                        backgroundColor: badge.bg,
                        borderColor: badge.border,
                        color: badge.fg,
                      }}
                    >
                      {badge.label}
                    </span>

                    {(step.result || step.errorResult) && (
                      <button
                        type="button"
                        onClick={() => onInspectStep(step.itemId)}
                        className="rounded border px-2 py-1 text-[11px] font-semibold"
                        style={{
                          backgroundColor: 'var(--surface-recessed)',
                          borderColor: 'var(--border-control)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        Detail
                      </button>
                    )}

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={isRunning || idx === 0}
                        onClick={() => onMoveStep(idx, -1)}
                        aria-label={`Pindahkan ${step.name} ke atas`}
                        title="Naikkan urutan"
                        className="inline-flex h-6 w-6 items-center justify-center rounded border disabled:opacity-35"
                        style={{
                          backgroundColor: 'var(--surface-recessed)',
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <HugeiconsIcon icon={ChevronUpIcon} size={13} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        disabled={isRunning || idx === steps.length - 1}
                        onClick={() => onMoveStep(idx, 1)}
                        aria-label={`Pindahkan ${step.name} ke bawah`}
                        title="Turunkan urutan"
                        className="inline-flex h-6 w-6 items-center justify-center rounded border disabled:opacity-35"
                        style={{
                          backgroundColor: 'var(--surface-recessed)',
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <HugeiconsIcon icon={ChevronDownIcon} size={13} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => onRemoveStep(step.itemId)}
                        aria-label={`Keluarkan ${step.name} dari antrean`}
                        title="Keluarkan dari antrean"
                        className="inline-flex h-6 w-6 items-center justify-center rounded border disabled:opacity-35"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--status-fail-fg)',
                        }}
                      >
                        <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.8} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};
