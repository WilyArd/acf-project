import React, { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ChevronLeftIcon,
  Copy01Icon,
  Delete02Icon,
  EyeIcon,
  FileExportIcon,
  FileImportIcon,
  ViewOffIcon,
} from '@hugeicons/core-free-icons';
import type { Environment, EnvVarType, EnvVariable } from '../types/api';
import { exportEnvironmentAsPostmanJson, nextUid } from '../lib/postmanImport';
import {
  normalizeUrlPathSlashes,
  substituteTemplate,
  transitionEnvVarType,
} from '../lib/variables';
import { ConfirmDialog } from './ConfirmDialog';

interface EnvironmentEditorProps {
  environment: Environment;
  isActive: boolean;
  sampleTemplateUrl: string;
  onUpdate: (updated: Environment) => void;
  onSetActive: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenImportEnv: () => void;
  onBackToWorkbench: () => void;
  canDelete: boolean;
}

export const EnvironmentEditor: React.FC<EnvironmentEditorProps> = ({
  environment,
  isActive,
  sampleTemplateUrl,
  onUpdate,
  onSetActive,
  onDuplicate,
  onDelete,
  onOpenImportEnv,
  onBackToWorkbench,
  canDelete,
}) => {
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [pendingDowngradeVar, setPendingDowngradeVar] = useState<{
    id: string;
    key: string;
  } | null>(null);

  const effectiveTemplate = sampleTemplateUrl.trim() || '{{url}}/api/example';
  const previewSub = substituteTemplate(effectiveTemplate, environment, null, null, {
    maskSecrets: true,
  });
  const cleanPreviewResolved = normalizeUrlPathSlashes(previewSub.resolved);

  const handleVarChange = (varId: string, patch: Partial<EnvVariable>) => {
    const targetVar = environment.variables.find((v) => v.id === varId);
    if (
      targetVar &&
      patch.type === 'default' &&
      targetVar.type === 'secret' &&
      targetVar.currentValue !== ''
    ) {
      setPendingDowngradeVar({ id: targetVar.id, key: targetVar.key || 'tanpa nama' });
      return;
    }

    onUpdate({
      ...environment,
      variables: environment.variables.map((v) => {
        if (v.id !== varId) return v;
        if (patch.type !== undefined && patch.type !== v.type) {
          return transitionEnvVarType(v, patch.type);
        }
        // Keep currentValue synced when user edits initialValue on a default variable that hasn't diverged
        if (patch.initialValue !== undefined && v.type === 'default') {
          const shouldSyncCurrent = v.currentValue === '' || v.currentValue === v.initialValue;
          return {
            ...v,
            initialValue: patch.initialValue,
            ...(shouldSyncCurrent ? { currentValue: patch.initialValue } : {}),
          };
        }
        return { ...v, ...patch };
      }),
    });
  };

  const confirmDowngradeSecret = () => {
    if (!pendingDowngradeVar) return;
    const varId = pendingDowngradeVar.id;
    setPendingDowngradeVar(null);
    onUpdate({
      ...environment,
      variables: environment.variables.map((v) =>
        v.id === varId ? transitionEnvVarType(v, 'default') : v,
      ),
    });
  };

  const handleAddVar = () => {
    onUpdate({
      ...environment,
      variables: [
        ...environment.variables,
        {
          id: nextUid('envv'),
          enabled: true,
          key: '',
          type: 'default',
          initialValue: '',
          currentValue: '',
        },
      ],
    });
  };

  const handleRemoveVar = (varId: string) => {
    onUpdate({
      ...environment,
      variables: environment.variables.filter((v) => v.id !== varId),
    });
  };

  const handleExport = () => {
    const json = exportEnvironmentAsPostmanJson(environment);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${environment.name.replace(/[^a-z0-9_-]/gi, '_')}.postman_environment.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setExportNotice('File Environment JSON diekspor (nilai bertipe Secret otomatis dikosongkan demi keamanan).');
  };

  return (
    <section
      aria-label="Editor Environment"
      className="flex min-h-full flex-1 flex-col"
      style={{ backgroundColor: 'var(--surface-canvas)' }}
    >
      {/* Editor Tab Strip */}
      <div
        className="flex items-center justify-between border-b px-4 py-2"
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-hairline)',
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold"
            style={{
              backgroundColor: 'var(--status-pass-bg)',
              color: 'var(--status-pass-fg)',
            }}
          >
            ENV
          </span>
          <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
            {environment.name}
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
        {/* Heading & Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <label htmlFor="env-name-input" className="sr-only">
              Nama Environment
            </label>
            <input
              id="env-name-input"
              type="text"
              value={environment.name}
              onChange={(e) => onUpdate({ ...environment, name: e.target.value })}
              className="h-10 rounded-md border bg-transparent px-3 text-base font-bold outline-offset-0"
              style={{
                borderColor: 'var(--border-control)',
                color: 'var(--text-primary)',
              }}
            />
            {isActive ? (
              <span
                className="rounded border px-2.5 py-1 text-xs font-semibold"
                style={{
                  backgroundColor: 'var(--status-pass-bg)',
                  borderColor: 'var(--status-pass-border)',
                  color: 'var(--status-pass-fg)',
                }}
              >
                Environment Aktif
              </span>
            ) : (
              <button
                type="button"
                onClick={onSetActive}
                className="rounded-md px-3 py-1.5 text-xs font-bold"
                style={{
                  backgroundColor: 'var(--brand-action)',
                  color: 'var(--brand-on-action)',
                }}
              >
                Jadikan Aktif
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenImportEnv}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--border-control)',
                color: 'var(--text-primary)',
              }}
            >
              <HugeiconsIcon icon={FileImportIcon} size={13} strokeWidth={1.8} />
              <span>Import Env JSON</span>
            </button>
            <button
              type="button"
              onClick={handleExport}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--border-control)',
                color: 'var(--text-primary)',
              }}
            >
              <HugeiconsIcon icon={FileExportIcon} size={13} strokeWidth={1.8} />
              <span>Export JSON</span>
            </button>
            <button
              type="button"
              onClick={onDuplicate}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--border-control)',
                color: 'var(--text-primary)',
              }}
            >
              <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} />
              <span>Duplikat</span>
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold"
                style={{
                  backgroundColor: 'var(--status-fail-bg)',
                  borderColor: 'var(--status-fail-border)',
                  color: 'var(--status-fail-fg)',
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.8} />
                <span>Hapus</span>
              </button>
            )}
          </div>
        </div>

        {/* Security Policy Banner */}
        <div
          className="rounded-md border px-3.5 py-2.5 text-xs leading-relaxed"
          style={{
            backgroundColor: 'var(--brand-tint)',
            borderColor: 'var(--brand-tint-border)',
            color: 'var(--brand-tint-text)',
          }}
        >
          <strong>Kebijakan Keamanan:</strong> Environment dikelola di memori sesi browser dan tidak pernah ditulis ke server atau localStorage. Variabel bertipe <strong>Secret</strong> selalu dimasking dan otomatis dikosongkan saat Export JSON.
        </div>

        {exportNotice && (
          <p role="status" className="text-xs font-medium" style={{ color: 'var(--status-pass-fg)' }}>
            {exportNotice}
          </p>
        )}

        {/* Variables Table */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
              Daftar Variabel ({environment.variables.length})
            </h2>
            <button
              type="button"
              onClick={handleAddVar}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-semibold"
              style={{
                backgroundColor: 'var(--brand-tint)',
                borderColor: 'var(--brand-tint-border)',
                color: 'var(--brand-tint-text)',
              }}
            >
              <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
              <span>Tambah Variabel</span>
            </button>
          </div>

          <div
            className="overflow-x-auto rounded-md border"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-hairline)',
            }}
          >
            <table className="w-full min-w-[740px] border-collapse text-left text-xs">
              <thead>
                <tr
                  className="border-b"
                  style={{
                    backgroundColor: 'var(--surface-recessed)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <th className="w-10 px-3 py-2 text-center font-semibold">On</th>
                  <th className="w-44 px-3 py-2 font-semibold">VARIABEL</th>
                  <th className="w-32 px-3 py-2 font-semibold">TIPE</th>
                  <th className="px-3 py-2 font-semibold">INITIAL VALUE</th>
                  <th className="px-3 py-2 font-semibold">CURRENT VALUE (SESI)</th>
                  <th className="w-28 px-3 py-2 text-right font-semibold">AKSI</th>
                </tr>
              </thead>
              <tbody>
                {environment.variables.map((v, idx) => {
                  const revealed = Boolean(revealedIds[v.id]);
                  const isSecret = v.type === 'secret';
                  return (
                    <tr
                      key={v.id}
                      className={idx < environment.variables.length - 1 ? 'border-b' : ''}
                      style={{ borderColor: 'var(--border-hairline)' }}
                    >
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={v.enabled}
                          onChange={(e) => handleVarChange(v.id, { enabled: e.target.checked })}
                          aria-label={`Aktifkan variabel ${v.key || idx + 1}`}
                          className="h-4 w-4 accent-[var(--brand-action)]"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          value={v.key}
                          onChange={(e) => handleVarChange(v.id, { key: e.target.value })}
                          placeholder="url"
                          aria-label={`Nama variabel ${idx + 1}`}
                          className="h-8 w-full rounded border bg-transparent px-2 font-mono text-xs font-semibold outline-offset-0"
                          style={{
                            borderColor: 'var(--border-hairline)',
                            color: 'var(--text-primary)',
                          }}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <select
                          value={v.type}
                          onChange={(e) =>
                            handleVarChange(v.id, { type: e.target.value as EnvVarType })
                          }
                          aria-label={`Tipe variabel ${v.key || idx + 1}`}
                          className="h-8 w-full rounded border px-2 text-xs font-semibold outline-offset-0"
                          style={
                            isSecret
                              ? {
                                  backgroundColor: 'var(--status-fail-bg)',
                                  borderColor: 'var(--status-fail-border)',
                                  color: 'var(--status-fail-fg)',
                                }
                              : {
                                  backgroundColor: 'var(--surface-recessed)',
                                  borderColor: 'var(--border-control)',
                                  color: 'var(--text-primary)',
                                }
                          }
                        >
                          <option value="default">Default</option>
                          <option value="secret">Secret</option>
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="text"
                          disabled={isSecret}
                          value={isSecret ? '' : v.initialValue}
                          onChange={(e) => handleVarChange(v.id, { initialValue: e.target.value })}
                          placeholder={isSecret ? '(tidak diekspor)' : 'https://...'}
                          aria-label={`Initial value variabel ${v.key || idx + 1}`}
                          className="h-8 w-full rounded border bg-transparent px-2 font-mono text-xs disabled:opacity-50"
                          style={{
                            borderColor: 'var(--border-hairline)',
                            color: 'var(--text-secondary)',
                          }}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1.5">
                          <input
                            type={isSecret && !revealed ? 'password' : 'text'}
                            value={v.currentValue}
                            onChange={(e) => handleVarChange(v.id, { currentValue: e.target.value })}
                            placeholder={isSecret ? 'Isi nilai rahasia sesi...' : 'Nilai aktif sesi'}
                            aria-label={`Current value variabel ${v.key || idx + 1}`}
                            className="h-8 min-w-0 flex-1 rounded border bg-transparent px-2 font-mono text-xs outline-offset-0"
                            style={{
                              borderColor: 'var(--border-hairline)',
                              color: 'var(--text-primary)',
                            }}
                          />
                          {isSecret && (
                            <button
                              type="button"
                              onClick={() =>
                                setRevealedIds((prev) => ({ ...prev, [v.id]: !prev[v.id] }))
                              }
                              className="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold"
                              style={{
                                borderColor: 'var(--border-control)',
                                color: 'var(--text-secondary)',
                              }}
                            >
                              <HugeiconsIcon
                                icon={revealed ? ViewOffIcon : EyeIcon}
                                size={12}
                                strokeWidth={1.8}
                              />
                              <span>{revealed ? 'Tutup' : 'Lihat'}</span>
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveVar(v.id)}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium"
                          style={{ color: 'var(--status-fail-fg)' }}
                        >
                          <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.8} />
                          <span>Hapus</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live Substitution Preview */}
        <div
          className="overflow-hidden rounded-md border"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <div
            className="border-b px-3.5 py-2 text-xs font-semibold"
            style={{
              backgroundColor: 'var(--surface-recessed)',
              borderColor: 'var(--border-hairline)',
              color: 'var(--text-primary)',
            }}
          >
            Preview Substitusi Langsung ({environment.name})
          </div>
          <div className="space-y-3 p-3.5 text-xs">
            <div>
              <p className="text-[10px] font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>
                {sampleTemplateUrl.trim() ? 'Template Request Saat Ini' : 'Contoh Template ({{url}})'}
              </p>
              <p className="mt-1 break-all font-mono" style={{ color: 'var(--brand-tint-text)' }}>
                {effectiveTemplate}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>
                Hasil Substitusi (Dikirim ke Fastify Proxy)
              </p>
              <p
                className="mt-1 break-all font-mono"
                style={{
                  color:
                    previewSub.unresolved.length > 0
                      ? 'var(--status-fail-fg)'
                      : 'var(--status-pass-fg)',
                }}
              >
                {cleanPreviewResolved || '(kosong)'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDowngradeVar !== null}
        tone="warning"
        title="Ubah Secret menjadi Default?"
        description={`Nilai sesi variabel "${pendingDowngradeVar?.key ?? ''}" akan tampil terbuka di editor dan tetap dikosongkan pada Initial Value saat export JSON.`}
        confirmLabel="Ubah ke Default"
        cancelLabel="Batal"
        onConfirm={confirmDowngradeSecret}
        onCancel={() => setPendingDowngradeVar(null)}
      />
    </section>
  );
};
