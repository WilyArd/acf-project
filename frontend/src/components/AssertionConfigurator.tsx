import React from 'react';
import {
  OPERATORS_BY_TYPE,
  type AssertionDraft,
  type AssertionOperator,
  type AssertionType,
} from '../types/api';
import { nextUid } from '../lib/postmanImport';

interface AssertionConfiguratorProps {
  assertions: AssertionDraft[];
  onChange: (next: AssertionDraft[]) => void;
}

const TYPE_LABELS: Record<AssertionType, string> = {
  STATUS_CODE: 'STATUS_CODE',
  LATENCY: 'LATENCY',
  BODY_JSON_PATH: 'BODY_JSON_PATH',
};

const OPERATOR_LABELS: Record<AssertionOperator, string> = {
  equals: 'equals',
  not_equals: 'not_equals',
  contains: 'contains',
  exists: 'exists',
  less_than_or_equal: 'less_than_or_equal (<=)',
};

export const AssertionConfigurator: React.FC<AssertionConfiguratorProps> = ({
  assertions,
  onChange,
}) => {
  const activeCount = assertions.filter((a) => a.enabled).length;

  const handleAdd = () => {
    onChange([
      ...assertions,
      {
        id: nextUid('asrt'),
        enabled: true,
        type: 'BODY_JSON_PATH',
        operator: 'equals',
        target: 'status',
        expectedInput: 'success',
      },
    ]);
  };

  const handleTypeChange = (id: string, nextType: AssertionType) => {
    const allowed = OPERATORS_BY_TYPE[nextType];
    const defaultOp = allowed[0];
    onChange(
      assertions.map((row) => {
        if (row.id !== id) return row;
        return {
          ...row,
          type: nextType,
          operator: defaultOp,
          target: nextType === 'BODY_JSON_PATH' ? row.target || 'data.token' : '',
          expectedInput:
            nextType === 'STATUS_CODE'
              ? '200'
              : nextType === 'LATENCY'
                ? '500'
                : defaultOp === 'exists'
                  ? ''
                  : row.expectedInput,
        };
      }),
    );
  };

  const handleOperatorChange = (id: string, nextOp: AssertionOperator) => {
    onChange(
      assertions.map((row) =>
        row.id === id
          ? {
              ...row,
              operator: nextOp,
              expectedInput: nextOp === 'exists' ? '' : row.expectedInput,
            }
          : row,
      ),
    );
  };

  const handleUpdate = (id: string, patch: Partial<AssertionDraft>) => {
    onChange(assertions.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const handleRemove = (id: string) => {
    onChange(assertions.filter((row) => row.id !== id));
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            Aturan Expected Result (Evaluasi Otomatis PASS / FAIL)
          </h2>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Minimal 1 assertion aktif wajib diisi. Gunakan dot-notation sederhana tanpa array index (mis. data.token).
          </p>
        </div>

        <button
          type="button"
          onClick={handleAdd}
          className="rounded-md border px-2.5 py-1 text-xs font-semibold"
          style={{
            backgroundColor: 'var(--brand-tint)',
            borderColor: 'var(--brand-tint-border)',
            color: 'var(--brand-tint-text)',
          }}
        >
          + Tambah Assertion
        </button>
      </div>

      {activeCount === 0 && (
        <div
          role="alert"
          className="rounded-md border px-3 py-2 text-xs font-medium"
          style={{
            backgroundColor: 'var(--status-warn-bg)',
            borderColor: 'var(--status-warn-border)',
            color: 'var(--status-warn-fg)',
          }}
        >
          Belum ada assertion aktif. Backend mewajibkan minimal 1 assertion (kode error NO_ASSERTIONS).
        </div>
      )}

      <div
        className="overflow-x-auto rounded-md border"
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        <table className="w-full min-w-[640px] border-collapse text-left text-xs">
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
              <th className="w-40 px-2.5 py-2 font-semibold">TIPE</th>
              <th className="w-44 px-2.5 py-2 font-semibold">OPERATOR</th>
              <th className="w-48 px-2.5 py-2 font-semibold">TARGET / DOT-PATH</th>
              <th className="px-2.5 py-2 font-semibold">EXPECTED VALUE</th>
              <th className="w-16 px-2.5 py-2 text-right font-semibold">AKSI</th>
            </tr>
          </thead>
          <tbody>
            {assertions.map((row, idx) => {
              const allowedOps = OPERATORS_BY_TYPE[row.type];
              const targetDisabled = row.type !== 'BODY_JSON_PATH';
              const expectedLockedNull = row.type === 'BODY_JSON_PATH' && row.operator === 'exists';

              return (
                <tr
                  key={row.id}
                  className={idx < assertions.length - 1 ? 'border-b' : ''}
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <td className="px-2.5 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(e) => handleUpdate(row.id, { enabled: e.target.checked })}
                      aria-label={`Aktifkan assertion ${idx + 1}`}
                      className="h-4 w-4 accent-[var(--brand-action)]"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={row.type}
                      onChange={(e) => handleTypeChange(row.id, e.target.value as AssertionType)}
                      aria-label={`Tipe assertion ${idx + 1}`}
                      className="h-8 w-full rounded border px-2 font-mono text-xs"
                      style={{
                        backgroundColor: 'var(--surface-recessed)',
                        borderColor: 'var(--border-control)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {(Object.keys(TYPE_LABELS) as AssertionType[]).map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <select
                      value={row.operator}
                      onChange={(e) =>
                        handleOperatorChange(row.id, e.target.value as AssertionOperator)
                      }
                      aria-label={`Operator assertion ${idx + 1}`}
                      className="h-8 w-full rounded border px-2 font-mono text-xs"
                      style={{
                        backgroundColor: 'var(--surface-recessed)',
                        borderColor: 'var(--border-control)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {allowedOps.map((op) => (
                        <option key={op} value={op}>
                          {OPERATOR_LABELS[op]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="text"
                      disabled={targetDisabled}
                      value={targetDisabled ? '' : row.target}
                      onChange={(e) => handleUpdate(row.id, { target: e.target.value })}
                      placeholder={targetDisabled ? 'Tidak dipakai (null)' : 'data.token'}
                      aria-label={`Target dot-path assertion ${idx + 1}`}
                      className="h-8 w-full rounded border px-2 font-mono text-xs disabled:opacity-50"
                      style={{
                        backgroundColor: targetDisabled
                          ? 'var(--surface-recessed)'
                          : 'transparent',
                        borderColor: 'var(--border-hairline)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type={row.type === 'STATUS_CODE' || row.type === 'LATENCY' ? 'number' : 'text'}
                      min={row.type === 'LATENCY' ? 1 : undefined}
                      disabled={expectedLockedNull}
                      value={expectedLockedNull ? 'null (key harus ada)' : row.expectedInput}
                      onChange={(e) => handleUpdate(row.id, { expectedInput: e.target.value })}
                      placeholder={
                        row.type === 'STATUS_CODE'
                          ? '200'
                          : row.type === 'LATENCY'
                            ? '500 (ms)'
                            : 'Nilai yang diharapkan'
                      }
                      aria-label={`Expected value assertion ${idx + 1}`}
                      className="h-8 w-full rounded border px-2 font-mono text-xs disabled:opacity-60"
                      style={{
                        backgroundColor: expectedLockedNull
                          ? 'var(--surface-recessed)'
                          : 'transparent',
                        borderColor: 'var(--border-hairline)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </td>
                  <td className="px-2.5 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleRemove(row.id)}
                      aria-label={`Hapus assertion ${idx + 1}`}
                      className="rounded px-2 py-1 text-[11px] font-medium"
                      style={{ color: 'var(--status-fail-fg)' }}
                    >
                      Hapus
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
