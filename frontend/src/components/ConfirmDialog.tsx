import React, { useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert02Icon, Cancel01Icon, Delete02Icon } from '@hugeicons/core-free-icons';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning';
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Konfirmasi',
  cancelLabel = 'Batal',
  tone = 'danger',
  onConfirm,
  onCancel,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const isDanger = tone === 'danger';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--scrim)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        className="w-full max-w-md overflow-hidden rounded-lg border"
        style={{
          backgroundColor: 'var(--surface-recessed)',
          borderColor: 'var(--border-control)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div
          className="flex items-start justify-between gap-3 border-b px-5 py-3.5"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
              style={
                isDanger
                  ? {
                      backgroundColor: 'var(--status-fail-bg)',
                      borderColor: 'var(--status-fail-border)',
                      color: 'var(--status-fail-fg)',
                    }
                  : {
                      backgroundColor: 'var(--status-warn-bg)',
                      borderColor: 'var(--status-warn-border)',
                      color: 'var(--status-warn-fg)',
                    }
              }
            >
              <HugeiconsIcon
                icon={isDanger ? Delete02Icon : Alert02Icon}
                size={16}
                strokeWidth={1.9}
              />
            </span>
            <h2
              id="confirm-dialog-title"
              className="text-sm font-bold"
              style={{ color: 'var(--text-primary)' }}
            >
              {title}
            </h2>
          </div>

          <button
            type="button"
            onClick={onCancel}
            aria-label="Tutup dialog"
            className="inline-flex h-7 w-7 items-center justify-center rounded"
            style={{ color: 'var(--text-muted)' }}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="px-5 py-4">
          <p
            id="confirm-dialog-desc"
            className="text-xs leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {description}
          </p>
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-3.5 py-1.5 text-xs font-semibold transition-colors"
            style={{
              backgroundColor: 'var(--surface-recessed)',
              borderColor: 'var(--border-control)',
              color: 'var(--text-primary)',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-xs font-bold transition-colors"
            style={
              isDanger
                ? {
                    backgroundColor: 'var(--status-fail-bg)',
                    borderColor: 'var(--status-fail-border)',
                    color: 'var(--status-fail-fg)',
                  }
                : {
                    backgroundColor: 'var(--brand-action)',
                    borderColor: 'var(--brand-action)',
                    color: 'var(--brand-on-action)',
                  }
            }
          >
            {isDanger && <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.9} />}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
