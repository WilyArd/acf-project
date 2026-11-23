import React from 'react';
import type { BatchStepResult } from '../lib/batchRunner';

interface BatchResultStripProps {
  steps: BatchStepResult[];
  isRunning: boolean;
  rateLimited: boolean;
  selectedItemId: string | null;
  onInspectStep: (itemId: string) => void;
  onDismiss: () => void;
}

function chipMeta(step: BatchStepResult) {
  switch (step.status) {
    case 'running':
      return { label: '...', bg: 'var(--brand-tint)', fg: 'var(--brand-tint-text)', border: 'var(--brand-tint-border)' };
    case 'pass':
      return { label: 'PASS', bg: 'var(--status-pass-bg)', fg: 'var(--status-pass-fg)', border: 'var(--status-pass-border)' };
    case 'fail':
      return { label: 'FAIL', bg: 'var(--status-fail-bg)', fg: 'var(--status-fail-fg)', border: 'var(--status-fail-border)' };
    case 'error':
      return { label: 'ERROR', bg: 'var(--status-error-bg)', fg: 'var(--status-error-fg)', border: 'var(--status-error-border)' };
    case 'validation':
      return { label: 'DITOLAK', bg: 'var(--status-warn-bg)', fg: 'var(--status-warn-fg)', border: 'var(--status-warn-border)' };
    case 'skipped':
    case 'aborted':
      return { label: 'SKIP', bg: 'var(--surface-recessed)', fg: 'var(--text-muted)', border: 'var(--border-hairline)' };
    default:
      return { label: 'ANTRI', bg: 'var(--surface-recessed)', fg: 'var(--text-secondary)', border: 'var(--border-hairline)' };
  }
}

export const BatchResultStrip: React.FC<BatchResultStripProps> = ({
  steps,
  isRunning,
  rateLimited,
  selectedItemId,
  onInspectStep,
  onDismiss,
}) => {
  const done = steps.filter((s) => s.status !== 'queued' && s.status !== 'running').length;
  const pass = steps.filter((s) => s.status === 'pass').length;
  const bad = steps.filter((s) => s.status === 'fail' || s.status === 'error' || s.status === 'validation').length;

  return (
    <div
      className="space-y-2 border-t px-4 py-2.5"
      style={{
        backgroundColor: 'var(--surface-elevated)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
          Hasil Multi-Run: {done}/{steps.length} selesai
          {isRunning ? ' (berjalan...)' : ''} ·{' '}
          <span style={{ color: 'var(--status-pass-fg)' }}>{pass} PASS</span>
          {bad > 0 && (
            <>
              {' · '}
              <span style={{ color: 'var(--status-fail-fg)' }}>{bad} gagal</span>
            </>
          )}
          <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
            klik nomor untuk melihat Hasil / Body / Headers di bawah
          </span>
        </span>
        {!isRunning && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-[11px] font-semibold"
            style={{ color: 'var(--text-muted)' }}
          >
            Tutup
          </button>
        )}
      </div>

      {rateLimited && (
        <p className="text-[11px] font-medium" style={{ color: 'var(--status-fail-fg)' }}>
          Dihentikan otomatis: rate limit backend (HTTP 429).
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {steps.map((step, idx) => {
          const meta = chipMeta(step);
          const selected = step.itemId === selectedItemId;
          return (
            <button
              key={step.itemId}
              type="button"
              onClick={() => onInspectStep(step.itemId)}
              title={`${step.method} ${step.name}${step.skipReason ? ` - ${step.skipReason}` : ''}`}
              className="inline-flex max-w-52 items-center gap-1.5 rounded border px-2 py-1 text-[11px]"
              style={{
                backgroundColor: meta.bg,
                borderColor: selected ? 'var(--brand-action)' : meta.border,
                color: meta.fg,
                outline: selected ? '1px solid var(--brand-action)' : 'none',
              }}
            >
              <span className="font-mono font-bold">#{idx + 1}</span>
              <span className="truncate">{step.name}</span>
              <span className="font-mono text-[10px] font-bold">{meta.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
