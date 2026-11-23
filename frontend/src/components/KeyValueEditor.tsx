import React, { useMemo } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Delete02Icon } from '@hugeicons/core-free-icons';
import type { KeyValueRow } from '../types/api';
import { nextUid } from '../lib/postmanImport';

interface KeyValueEditorProps {
  title: string;
  helperText?: string;
  rows: KeyValueRow[];
  onChange: (next: KeyValueRow[]) => void;
  caseInsensitiveKeys?: boolean;
  presets?: Array<{ label: string; key: string; value: string; description: string }>;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export const KeyValueEditor: React.FC<KeyValueEditorProps> = ({
  title,
  helperText,
  rows,
  onChange,
  caseInsensitiveKeys = false,
  presets,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value (dukung {{variabel}})',
}) => {
  const normalizeKey = (k: string) => (caseInsensitiveKeys ? k.trim().toLowerCase() : k.trim());

  // Non-destructive duplicate detection: never delete a row while the user is typing
  const { overriddenRowIds, duplicateKeys } = useMemo(() => {
    const lastIndexByKey = new Map<string, number>();
    const dupKeys = new Set<string>();
    rows.forEach((r, idx) => {
      if (!r.enabled) return;
      const norm = normalizeKey(r.key);
      if (!norm) return;
      if (lastIndexByKey.has(norm)) {
        dupKeys.add(r.key.trim());
      }
      lastIndexByKey.set(norm, idx);
    });

    const overridden = new Set<string>();
    rows.forEach((r, idx) => {
      if (!r.enabled) return;
      const norm = normalizeKey(r.key);
      if (!norm) return;
      if (lastIndexByKey.get(norm) !== idx) {
        overridden.add(r.id);
      }
    });

    return { overriddenRowIds: overridden, duplicateKeys: Array.from(dupKeys) };
  }, [rows, caseInsensitiveKeys]);

  const handleUpdate = (id: string, patch: Partial<KeyValueRow>) => {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const handleAddRow = () => {
    onChange([
      ...rows,
      { id: nextUid('kv'), enabled: true, key: '', value: '', description: '' },
    ]);
  };

  const handleRemoveRow = (id: string) => {
    onChange(rows.filter((r) => r.id !== id));
  };

  const handleApplyPreset = (preset: { key: string; value: string; description: string }) => {
    const targetNorm = normalizeKey(preset.key);
    const existing = rows.find((r) => normalizeKey(r.key) === targetNorm);
    if (existing) {
      onChange(
        rows.map((r) =>
          r.id === existing.id
            ? { ...r, enabled: true, key: preset.key, value: preset.value, description: preset.description }
            : r,
        ),
      );
      return;
    }
    onChange([
      ...rows,
      {
        id: nextUid('kv'),
        enabled: true,
        key: preset.key,
        value: preset.value,
        description: preset.description,
      },
    ]);
  };

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h2>
          {helperText && (
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {helperText}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {presets?.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => handleApplyPreset(preset)}
              className="rounded-md border px-2 py-1 text-[11px] font-medium transition-colors"
              style={{
                backgroundColor: 'var(--surface-recessed)',
                borderColor: 'var(--border-control)',
                color: 'var(--text-primary)',
              }}
            >
              + {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={handleAddRow}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors"
            style={{
              backgroundColor: 'var(--brand-tint)',
              borderColor: 'var(--brand-tint-border)',
              color: 'var(--brand-tint-text)',
            }}
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
            <span>Tambah Baris</span>
          </button>
        </div>
      </div>

      {duplicateKeys.length > 0 && (
        <div
          role="status"
          className="rounded-md border px-3 py-1.5 text-xs"
          style={{
            backgroundColor: 'var(--status-warn-bg)',
            borderColor: 'var(--status-warn-border)',
            color: 'var(--status-warn-fg)',
          }}
        >
          Key duplikat terdeteksi ({duplicateKeys.join(', ')}): backend hanya menerima key unik, sehingga nilai pada baris aktif terakhir akan dipakai saat Execute.
        </div>
      )}

      <div
        className="overflow-x-auto rounded-md border"
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        <table className="w-full min-w-[520px] border-collapse text-left text-xs">
          <thead>
            <tr
              className="border-b"
              style={{
                backgroundColor: 'var(--surface-recessed)',
                borderColor: 'var(--border-hairline)',
                color: 'var(--text-muted)',
              }}
            >
              <th className="w-10 px-2.5 py-2 text-center font-semibold">On</th>
              <th className="w-1/3 px-2.5 py-2 font-semibold">KEY</th>
              <th className="w-1/3 px-2.5 py-2 font-semibold">VALUE</th>
              <th className="px-2.5 py-2 font-semibold">DESKRIPSI</th>
              <th className="w-16 px-2.5 py-2 text-right font-semibold">AKSI</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-4 text-center text-xs"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Belum ada baris. Klik "+ Tambah Baris" atau gunakan preset di atas.
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => {
                const isOverridden = overriddenRowIds.has(row.id);
                return (
                  <tr
                    key={row.id}
                    className={idx < rows.length - 1 ? 'border-b' : ''}
                    style={{
                      borderColor: 'var(--border-hairline)',
                      opacity: row.enabled ? 1 : 0.6,
                    }}
                  >
                    <td className="px-2.5 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(e) => handleUpdate(row.id, { enabled: e.target.checked })}
                        aria-label={`Aktifkan baris ${row.key || idx + 1}`}
                        className="h-4 w-4 accent-[var(--brand-action)]"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) => handleUpdate(row.id, { key: e.target.value })}
                          placeholder={keyPlaceholder}
                          aria-label={`Key baris ${idx + 1}`}
                          className="h-8 min-w-0 flex-1 rounded border bg-transparent px-2 font-mono text-xs"
                          style={{
                            borderColor: isOverridden
                              ? 'var(--status-warn-border)'
                              : 'var(--border-hairline)',
                            color: 'var(--text-primary)',
                          }}
                        />
                        {isOverridden && (
                          <span
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                            style={{
                              backgroundColor: 'var(--status-warn-bg)',
                              color: 'var(--status-warn-fg)',
                            }}
                            title="Key ini ditimpa oleh baris duplikat di bawahnya"
                          >
                            Ditindih
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        value={row.value}
                        onChange={(e) => handleUpdate(row.id, { value: e.target.value })}
                        placeholder={valuePlaceholder}
                        aria-label={`Value baris ${idx + 1}`}
                        className="h-8 w-full rounded border bg-transparent px-2 font-mono text-xs"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        value={row.description}
                        onChange={(e) => handleUpdate(row.id, { description: e.target.value })}
                        placeholder="Catatan opsional"
                        aria-label={`Deskripsi baris ${idx + 1}`}
                        className="h-8 w-full rounded border bg-transparent px-2 text-xs"
                        style={{
                          borderColor: 'var(--border-hairline)',
                          color: 'var(--text-secondary)',
                        }}
                      />
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => handleRemoveRow(row.id)}
                        aria-label={`Hapus baris ${row.key || idx + 1}`}
                        title="Hapus baris"
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium"
                        style={{ color: 'var(--status-fail-fg)' }}
                      >
                        <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.8} />
                        <span>Hapus</span>
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
