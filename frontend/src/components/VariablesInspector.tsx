import React, { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  Cancel01Icon,
  CheckIcon,
  Edit02Icon,
  EyeIcon,
  Layers01Icon,
  ViewOffIcon,
} from '@hugeicons/core-free-icons';
import type { Environment } from '../types/api';
import { maskSecret, type ResolvedVariableRef } from '../lib/variables';

interface VariablesInspectorProps {
  activeEnv: Environment | null;
  collectionEnv?: Environment | null;
  references: ResolvedVariableRef[];
  resolvedUrl: string;
  variableSources?: Record<string, 'environment' | 'collection'>;
  collectionEnvName?: string | null;
  onEditEnv: () => void;
  onQuickAddVariable: (varName: string) => void;
  onQuickUpdateVariable?: (
    varKey: string,
    nextValue: string,
    scope?: 'environment' | 'collection',
  ) => void;
  onClose: () => void;
}

export const VariablesInspector: React.FC<VariablesInspectorProps> = ({
  activeEnv,
  collectionEnv = null,
  references,
  resolvedUrl,
  variableSources = {},
  collectionEnvName = null,
  onEditEnv,
  onQuickAddVariable,
  onQuickUpdateVariable,
  onClose,
}) => {
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [showAllEnvVars, setShowAllEnvVars] = useState(true);
  const [editingTarget, setEditingTarget] = useState<{
    section: 'ref' | 'env';
    key: string;
    value: string;
    isSecret: boolean;
    scope: 'environment' | 'collection';
  } | null>(null);

  const displayedEnv = activeEnv ?? collectionEnv;
  const displayedScope: 'environment' | 'collection' = activeEnv ? 'environment' : 'collection';

  const commitInlineEdit = () => {
    if (!editingTarget || !onQuickUpdateVariable) return;
    onQuickUpdateVariable(editingTarget.key, editingTarget.value, editingTarget.scope);
    setEditingTarget(null);
  };

  return (
    <aside
      id="variables-inspector"
      aria-label="Inspector Variabel Request"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden border-l"
      style={{
        backgroundColor: 'var(--surface-elevated)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      <div
        className="flex h-10 items-center justify-between border-b px-3.5"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <h2
          className="flex items-center gap-1.5 text-xs font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          <HugeiconsIcon
            icon={Layers01Icon}
            size={14}
            strokeWidth={1.8}
            style={{ color: 'var(--brand-tint-text)' }}
          />
          <span>Variabel pada Request</span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup panel variabel"
          className="inline-flex h-7 w-7 items-center justify-center rounded"
          style={{ color: 'var(--text-secondary)' }}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3">
        {/* Variables referenced in active request */}
        <div className="space-y-2">
          <p
            className="text-[10px] font-semibold tracking-wider uppercase"
            style={{ color: 'var(--text-muted)' }}
          >
            Digunakan di Request ({references.length})
          </p>

          {references.length === 0 ? (
            <p
              className="rounded-md border p-2.5 text-xs"
              style={{
                backgroundColor: 'var(--surface-recessed)',
                borderColor: 'var(--border-hairline)',
                color: 'var(--text-secondary)',
              }}
            >
              Belum ada placeholder {'{{variabel}}'} di URL, Params, Headers, atau Body.
            </p>
          ) : (
            references.map((ref) => {
              const sourceType = variableSources[ref.name];
              const badge =
                ref.scope === 'environment'
                  ? sourceType === 'collection'
                    ? {
                        letter: 'C',
                        bg: 'var(--brand-tint)',
                        fg: 'var(--brand-tint-text)',
                        label: collectionEnvName ?? 'Collection Vars',
                      }
                    : {
                        letter: 'E',
                        bg: 'var(--status-pass-bg)',
                        fg: 'var(--status-pass-fg)',
                        label: activeEnv?.name ?? 'Env',
                      }
                  : ref.scope === 'passthrough'
                    ? { letter: 'T', bg: 'var(--brand-tint)', fg: 'var(--brand-tint-text)', label: 'Passthrough' }
                    : { letter: '!', bg: 'var(--status-fail-bg)', fg: 'var(--status-fail-fg)', label: 'Belum ada' };

              const isEditingThisRef =
                editingTarget?.section === 'ref' && editingTarget.key === ref.name;
              const refSourceScope: 'environment' | 'collection' =
                sourceType === 'collection' ? 'collection' : 'environment';

              return (
                <div
                  key={ref.name}
                  className="rounded-md border p-2.5"
                  style={{
                    backgroundColor: 'var(--surface-recessed)',
                    borderColor:
                      ref.scope === 'unresolved'
                        ? 'var(--status-fail-border)'
                        : 'var(--border-hairline)',
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-bold"
                        style={{ backgroundColor: badge.bg, color: badge.fg }}
                      >
                        {badge.letter}
                      </span>
                      <span
                        className="truncate font-mono text-xs font-bold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {ref.name}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className="text-[10px] font-semibold"
                        style={{ color: badge.fg }}
                      >
                        {badge.label}
                      </span>
                      {ref.scope === 'environment' && onQuickUpdateVariable && !isEditingThisRef && (
                        <button
                          type="button"
                          onClick={() =>
                            setEditingTarget({
                              section: 'ref',
                              key: ref.name,
                              value: ref.resolvedValue ?? '',
                              isSecret: ref.isSecret,
                              scope: refSourceScope,
                            })
                          }
                          aria-label={`Edit nilai ${ref.name}`}
                          title={`Edit cepat nilai ${ref.name}`}
                          className="inline-flex h-5 w-5 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100"
                          style={{ color: 'var(--brand-tint-text)' }}
                        >
                          <HugeiconsIcon icon={Edit02Icon} size={11} strokeWidth={1.8} />
                        </button>
                      )}
                    </div>
                  </div>
                  {isEditingThisRef && editingTarget ? (
                    <div className="mt-2 space-y-1.5">
                      <input
                        type={editingTarget.isSecret ? 'password' : 'text'}
                        autoFocus
                        value={editingTarget.value}
                        onChange={(e) =>
                          setEditingTarget({ ...editingTarget, value: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitInlineEdit();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditingTarget(null);
                          }
                        }}
                        aria-label={`Nilai baru untuk ${ref.name}`}
                        className="h-7 w-full rounded border bg-transparent px-2 font-mono text-[11px]"
                        style={{
                          backgroundColor: 'var(--surface-canvas)',
                          borderColor: 'var(--brand-tint-border)',
                          color: 'var(--text-primary)',
                        }}
                      />
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingTarget(null)}
                          className="inline-flex items-center gap-0.5 rounded border px-2 py-0.5 text-[10px] font-medium"
                          style={{
                            borderColor: 'var(--border-hairline)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                          <span>Batal</span>
                        </button>
                        <button
                          type="button"
                          onClick={commitInlineEdit}
                          className="inline-flex items-center gap-0.5 rounded px-2 py-0.5 text-[10px] font-bold"
                          style={{
                            backgroundColor: 'var(--brand-action)',
                            color: 'var(--brand-on-action)',
                          }}
                        >
                          <HugeiconsIcon icon={CheckIcon} size={10} strokeWidth={2} />
                          <span>Simpan</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p
                      onClick={() => {
                        if (ref.scope === 'environment' && onQuickUpdateVariable) {
                          setEditingTarget({
                            section: 'ref',
                            key: ref.name,
                            value: ref.resolvedValue ?? '',
                            isSecret: ref.isSecret,
                            scope: refSourceScope,
                          });
                        }
                      }}
                      title={
                        ref.scope === 'environment' && onQuickUpdateVariable
                          ? 'Klik untuk edit cepat nilai variabel'
                          : undefined
                      }
                      className={`mt-1.5 break-all font-mono text-[11px] ${
                        ref.scope === 'environment' && onQuickUpdateVariable
                          ? 'cursor-pointer rounded px-1 py-0.5 -mx-1 hover:bg-[var(--surface-hover)]'
                          : ''
                      }`}
                      style={{
                        color:
                          ref.scope === 'unresolved'
                            ? 'var(--status-fail-fg)'
                            : 'var(--text-secondary)',
                      }}
                    >
                      {ref.scope === 'unresolved'
                        ? ref.name.startsWith('$.')
                          ? 'Jalankan request penghasil token terlebih dahulu atau ekstrak token manual.'
                          : 'Nilai belum terdefinisi pada Environment aktif.'
                        : ref.isSecret
                          ? `${maskSecret(ref.resolvedValue ?? '')} (secret sesi)`
                          : ref.resolvedValue || '(kosong)'}
                    </p>
                  )}
                  {ref.scope === 'unresolved' && !ref.name.startsWith('$.') && (
                    <button
                      type="button"
                      onClick={() => onQuickAddVariable(ref.name)}
                      className="mt-2 inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-semibold"
                      style={{
                        backgroundColor: 'var(--brand-tint)',
                        borderColor: 'var(--brand-tint-border)',
                        color: 'var(--brand-tint-text)',
                      }}
                    >
                      <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
                      <span>Tambah "{ref.name}" ke Environment</span>
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* All variables in active Environment */}
        <div
          className="space-y-2 border-t pt-3"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowAllEnvVars((s) => !s)}
              aria-expanded={showAllEnvVars}
              className="text-left text-[11px] font-semibold"
              style={{ color: 'var(--text-secondary)' }}
            >
              {showAllEnvVars ? 'v' : '>'} Semua Variabel{' '}
              {displayedEnv ? `(${displayedEnv.name})` : '(Kosong)'}
            </button>
            <button
              type="button"
              onClick={onEditEnv}
              className="inline-flex items-center gap-1 text-[11px] font-semibold"
              style={{ color: 'var(--brand-tint-text)' }}
            >
              <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.8} />
              <span>Edit</span>
            </button>
          </div>

          {showAllEnvVars && (
            <div className="space-y-1.5">
              {!displayedEnv || displayedEnv.variables.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Tidak ada Environment aktif.
                </p>
              ) : (
                displayedEnv.variables.map((v) => {
                  const revealed = Boolean(revealedIds[v.id]);
                  const effective = v.currentValue || v.initialValue;
                  const isEditingThisVar =
                    editingTarget?.section === 'env' && editingTarget.key === v.key.trim();

                  return (
                    <div
                      key={v.id}
                      className="rounded border px-2 py-1.5 text-[11px]"
                      style={{
                        backgroundColor: 'var(--surface-canvas)',
                        borderColor: 'var(--border-hairline)',
                        opacity: v.enabled ? 1 : 0.55,
                      }}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className="truncate font-mono font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {v.key || '(tanpa nama)'}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {v.type === 'secret' && effective !== '' && (
                            <button
                              type="button"
                              onClick={() =>
                                setRevealedIds((prev) => ({ ...prev, [v.id]: !prev[v.id] }))
                              }
                              aria-label={revealed ? 'Sembunyikan nilai' : 'Lihat nilai'}
                              className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold"
                              style={{ color: 'var(--brand-tint-text)' }}
                            >
                              <HugeiconsIcon
                                icon={revealed ? ViewOffIcon : EyeIcon}
                                size={12}
                                strokeWidth={1.8}
                              />
                              <span>{revealed ? 'Sembunyi' : 'Lihat'}</span>
                            </button>
                          )}
                          {v.key.trim() !== '' && onQuickUpdateVariable && !isEditingThisVar && (
                            <button
                              type="button"
                              onClick={() =>
                                setEditingTarget({
                                  section: 'env',
                                  key: v.key.trim(),
                                  value: effective,
                                  isSecret: v.type === 'secret' && !revealed,
                                  scope: displayedScope,
                                })
                              }
                              aria-label={`Edit nilai ${v.key}`}
                              title={`Edit cepat nilai ${v.key}`}
                              className="inline-flex h-5 w-5 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100"
                              style={{ color: 'var(--brand-tint-text)' }}
                            >
                              <HugeiconsIcon icon={Edit02Icon} size={11} strokeWidth={1.8} />
                            </button>
                          )}
                        </div>
                      </div>

                      {isEditingThisVar && editingTarget ? (
                        <div className="mt-1.5 space-y-1.5">
                          <input
                            type={editingTarget.isSecret ? 'password' : 'text'}
                            autoFocus
                            value={editingTarget.value}
                            onChange={(e) =>
                              setEditingTarget({ ...editingTarget, value: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitInlineEdit();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditingTarget(null);
                              }
                            }}
                            aria-label={`Nilai baru untuk ${v.key}`}
                            className="h-7 w-full rounded border bg-transparent px-2 font-mono text-[11px]"
                            style={{
                              backgroundColor: 'var(--surface-recessed)',
                              borderColor: 'var(--brand-tint-border)',
                              color: 'var(--text-primary)',
                            }}
                          />
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => setEditingTarget(null)}
                              className="inline-flex items-center gap-0.5 rounded border px-2 py-0.5 text-[10px] font-medium"
                              style={{
                                borderColor: 'var(--border-hairline)',
                                color: 'var(--text-muted)',
                              }}
                            >
                              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                              <span>Batal</span>
                            </button>
                            <button
                              type="button"
                              onClick={commitInlineEdit}
                              className="inline-flex items-center gap-0.5 rounded px-2 py-0.5 text-[10px] font-bold"
                              style={{
                                backgroundColor: 'var(--brand-action)',
                                color: 'var(--brand-on-action)',
                              }}
                            >
                              <HugeiconsIcon icon={CheckIcon} size={10} strokeWidth={2} />
                              <span>Simpan</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p
                          onClick={() => {
                            if (v.key.trim() !== '' && onQuickUpdateVariable) {
                              setEditingTarget({
                                section: 'env',
                                key: v.key.trim(),
                                value: effective,
                                isSecret: v.type === 'secret' && !revealed,
                                scope: displayedScope,
                              });
                            }
                          }}
                          title={
                            v.key.trim() !== '' && onQuickUpdateVariable
                              ? 'Klik untuk edit cepat nilai variabel'
                              : undefined
                          }
                          className={`mt-0.5 break-all font-mono ${
                            v.key.trim() !== '' && onQuickUpdateVariable
                              ? 'cursor-pointer rounded px-1 py-0.5 -mx-1 hover:bg-[var(--surface-hover)]'
                              : ''
                          }`}
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {v.type === 'secret' && !revealed
                            ? maskSecret(effective)
                            : effective || '(kosong)'}
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Resolved Outbound Target Preview */}
        {resolvedUrl && (
          <div
            className="space-y-1 border-t pt-3"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <p
              className="text-[10px] font-semibold tracking-wider uppercase"
              style={{ color: 'var(--text-muted)' }}
            >
              Preview URL Final
            </p>
            <p
              className="break-all rounded border p-2 font-mono text-[11px]"
              style={{
                backgroundColor: 'var(--surface-canvas)',
                borderColor: 'var(--border-hairline)',
                color: 'var(--text-primary)',
              }}
            >
              {resolvedUrl}
            </p>
          </div>
        )}
      </div>

      {/* Security Policy Card */}
      <div
        className="m-3 rounded-md border p-2.5 text-[11px] leading-relaxed"
        style={{
          backgroundColor: 'var(--surface-recessed)',
          borderColor: 'var(--border-hairline)',
          color: 'var(--text-secondary)',
        }}
      >
        <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>
          Kebijakan Keamanan Sesi
        </p>
        <p className="mt-0.5">
          Substitusi {'{{variabel}}'} dilakukan di browser sebelum pengecekan SSRF DNS dan CRLF pada proxy. Variabel bertipe Secret dan token passthrough hanya hidup di memori sesi.
        </p>
      </div>
    </aside>
  );
};
