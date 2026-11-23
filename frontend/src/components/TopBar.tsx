import React, { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ChevronDownIcon,
  CodeIcon,
  FileImportIcon,
  Layers01Icon,
  Moon02Icon,
  Search01Icon,
  Sun02Icon,
} from '@hugeicons/core-free-icons';
import type { Environment, ThemeMode } from '../types/api';

interface TopBarProps {
  theme: ThemeMode;
  onToggleTheme: (next: ThemeMode) => void;
  environments: Environment[];
  activeEnvId: string | null;
  onSelectEnv: (id: string | null) => void;
  onCreateEnv: () => void;
  onOpenImport: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  unresolvedCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  mobileMenuOpen: boolean;
  onToggleMobileMenu: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  theme,
  onToggleTheme,
  environments,
  activeEnvId,
  onSelectEnv,
  onCreateEnv,
  onOpenImport,
  inspectorOpen,
  onToggleInspector,
  unresolvedCount,
  searchQuery,
  onSearchChange,
  searchInputRef,
  mobileMenuOpen,
  onToggleMobileMenu,
}) => {
  const [envMenuOpen, setEnvMenuOpen] = useState(false);
  const [envFilter, setEnvFilter] = useState('');
  const envDropdownRef = useRef<HTMLDivElement | null>(null);

  const activeEnv = environments.find((e) => e.id === activeEnvId) ?? null;
  const filteredEnvs = environments.filter((e) =>
    e.name.toLowerCase().includes(envFilter.trim().toLowerCase()),
  );

  useEffect(() => {
    if (!envMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (envDropdownRef.current && !envDropdownRef.current.contains(event.target as Node)) {
        setEnvMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEnvMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [envMenuOpen]);

  return (
    <header
      className="sticky top-0 z-30 flex min-h-12 w-full min-w-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5 sm:px-4"
      style={{
        backgroundColor: 'var(--surface-elevated)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      {/* Left: Mobile Drawer Trigger + Brand */}
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={onToggleMobileMenu}
          aria-expanded={mobileMenuOpen}
          aria-controls="workbench-sidebar"
          aria-label="Buka atau tutup menu navigasi"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-colors lg:hidden"
          style={{
            backgroundColor: 'var(--surface-recessed)',
            borderColor: 'var(--border-control)',
            color: 'var(--text-primary)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 4h12M2 8h12M2 12h12"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <span>Menu</span>
        </button>

        <div className="flex items-center gap-2">
          <img
            src="/acf-logo.svg"
            alt=""
            aria-hidden="true"
            className="h-6 w-auto shrink-0 object-contain"
          />
          <div className="flex items-center gap-2">
            <h1
              className="text-sm font-semibold tracking-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              ACF Workbench
            </h1>
            <span
              className="hidden h-4 w-px sm:inline-block"
              style={{ backgroundColor: 'var(--border-hairline)' }}
              aria-hidden="true"
            />
            <span
              className="hidden text-xs md:inline"
              style={{ color: 'var(--text-secondary)' }}
            >
              API Testing Tool
            </span>
          </div>
        </div>
      </div>

      {/* Center: Quick Filter */}
      <div className="hidden flex-1 justify-center px-4 xl:flex">
        <div
          className="relative flex w-full max-w-sm items-center gap-2 rounded-md border px-2.5"
          style={{
            backgroundColor: 'var(--surface-recessed)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          <HugeiconsIcon
            icon={Search01Icon}
            size={14}
            strokeWidth={1.8}
            className="shrink-0"
            style={{ color: 'var(--text-muted)' }}
          />
          <label htmlFor="global-filter-input" className="sr-only">
            Cari endpoint atau environment
          </label>
          <input
            ref={searchInputRef}
            id="global-filter-input"
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter endpoint atau environment..."
            className="h-8 w-full bg-transparent text-xs"
            style={{ color: 'var(--text-primary)' }}
          />
          <kbd
            className="ml-1 shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px]"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-control)',
              color: 'var(--text-secondary)',
            }}
          >
            Ctrl K
          </kbd>
        </div>
      </div>

      {/* Right: Import, Theme Toggle, Environment Switcher, Variables Quick-Look */}
      <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:gap-2">
        <button
          type="button"
          onClick={onOpenImport}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-colors sm:px-3 lg:min-h-8"
          style={{
            backgroundColor: 'var(--surface-recessed)',
            borderColor: 'var(--border-control)',
            color: 'var(--text-primary)',
          }}
        >
          <HugeiconsIcon icon={FileImportIcon} size={14} strokeWidth={1.8} />
          <span>Import</span>
        </button>

        {/* Single-button Theme Toggle */}
        <button
          type="button"
          onClick={() => onToggleTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-pressed={theme === 'light'}
          aria-label={
            theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'
          }
          title={theme === 'dark' ? 'Tema: Gelap (klik untuk Terang)' : 'Tema: Terang (klik untuk Gelap)'}
          className="inline-flex min-h-11 w-11 items-center justify-center rounded-md border transition-colors lg:min-h-8 lg:w-8"
          style={{
            backgroundColor: 'var(--surface-recessed)',
            borderColor: 'var(--border-control)',
            color: 'var(--text-primary)',
          }}
        >
          <HugeiconsIcon
            icon={theme === 'dark' ? Moon02Icon : Sun02Icon}
            size={15}
            strokeWidth={1.8}
          />
        </button>

        {/* Environment Switcher Dropdown */}
        <div ref={envDropdownRef} className="relative min-w-0 flex-1 sm:flex-initial">
          <button
            type="button"
            onClick={() => setEnvMenuOpen((open) => !open)}
            aria-expanded={envMenuOpen}
            aria-haspopup="listbox"
            className="inline-flex min-h-11 w-full max-w-[220px] items-center justify-between gap-1.5 rounded-md border px-2 text-xs font-semibold transition-colors sm:w-auto sm:min-w-[180px] sm:gap-2 sm:px-2.5 lg:min-h-8"
            style={{
              backgroundColor: 'var(--surface-recessed)',
              borderColor:
                unresolvedCount > 0 && !activeEnv
                  ? 'var(--status-fail-border)'
                  : envMenuOpen
                    ? 'var(--brand-action)'
                    : 'var(--border-control)',
              color: 'var(--text-primary)',
            }}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <HugeiconsIcon
                icon={Layers01Icon}
                size={14}
                strokeWidth={1.8}
                className="shrink-0"
                style={{
                  color: activeEnv
                    ? 'var(--status-pass-fg)'
                    : 'var(--text-muted)',
                }}
              />
              <span className="truncate">{activeEnv ? activeEnv.name : 'No Environment'}</span>
            </span>
            <HugeiconsIcon
              icon={ChevronDownIcon}
              size={13}
              strokeWidth={2}
              className={`shrink-0 transition-transform duration-150 ${envMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {envMenuOpen && (
            <div
              role="listbox"
              aria-label="Pilih Environment aktif"
              className="absolute right-0 top-full z-50 mt-1.5 w-68 rounded-lg border p-2"
              style={{
                backgroundColor: 'var(--surface-recessed)',
                borderColor: 'var(--border-control)',
                boxShadow: 'var(--shadow-popover)',
              }}
            >
              <label htmlFor="env-switcher-search" className="sr-only">
                Cari environment
              </label>
              <input
                id="env-switcher-search"
                type="search"
                value={envFilter}
                onChange={(e) => setEnvFilter(e.target.value)}
                placeholder="Cari environment..."
                className="mb-1.5 h-8 w-full rounded-md border px-2.5 text-xs"
                style={{
                  backgroundColor: 'var(--surface-elevated)',
                  borderColor: 'var(--border-hairline)',
                  color: 'var(--text-primary)',
                }}
              />
              <p className="px-1.5 pb-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Environment aktif digunakan untuk substitusi {'{{variabel}}'}.
              </p>

              <div
                className="max-h-56 space-y-0.5 overflow-y-auto border-y py-1.5"
                style={{ borderColor: 'var(--border-hairline)' }}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={activeEnvId === null}
                  onClick={() => {
                    onSelectEnv(null);
                    setEnvMenuOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors"
                  style={
                    activeEnvId === null
                      ? {
                          backgroundColor: 'var(--brand-tint)',
                          color: 'var(--brand-tint-text)',
                          fontWeight: 600,
                        }
                      : { color: 'var(--text-secondary)' }
                  }
                >
                  <span>No Environment</span>
                  {activeEnvId === null && <span aria-hidden="true">Aktif</span>}
                </button>

                {filteredEnvs.map((env) => {
                  const selected = env.id === activeEnvId;
                  return (
                    <button
                      key={env.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onSelectEnv(env.id);
                        setEnvMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors"
                      style={
                        selected
                          ? {
                              backgroundColor: 'var(--brand-tint)',
                              color: 'var(--brand-tint-text)',
                              fontWeight: 600,
                            }
                          : { color: 'var(--text-primary)' }
                      }
                    >
                      <span className="truncate">{env.name}</span>
                      <span
                        className="ml-2 shrink-0 text-[10px]"
                        style={{ color: selected ? 'var(--brand-tint-text)' : 'var(--text-muted)' }}
                      >
                        {env.variables.length} var
                      </span>
                    </button>
                  );
                })}
                {filteredEnvs.length === 0 && (
                  <p className="px-2 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    Environment tidak ditemukan.
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setEnvMenuOpen(false);
                  onCreateEnv();
                }}
                className="mt-1.5 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs font-semibold transition-colors"
                style={{ color: 'var(--brand-tint-text)' }}
              >
                <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
                <span>Buat Environment Baru</span>
              </button>
            </div>
          )}
        </div>

        {/* Variables Quick-Look Inspector Toggle */}
        <button
          type="button"
          onClick={onToggleInspector}
          aria-expanded={inspectorOpen}
          aria-controls="variables-inspector"
          aria-label="Buka atau tutup panel variabel request"
          title="Panel Variabel Request"
          className={`relative inline-flex min-h-11 items-center justify-center gap-1 rounded-md border text-xs font-bold transition-colors lg:min-h-8 ${
            unresolvedCount > 0 ? 'px-2' : 'w-11 lg:w-8'
          }`}
          style={
            inspectorOpen
              ? {
                  backgroundColor: 'var(--brand-tint)',
                  borderColor: 'var(--brand-tint-border)',
                  color: 'var(--brand-tint-text)',
                }
              : {
                  backgroundColor: 'var(--surface-recessed)',
                  borderColor: 'var(--border-control)',
                  color: 'var(--text-primary)',
                }
          }
        >
          <HugeiconsIcon icon={CodeIcon} size={15} strokeWidth={2} />
          {unresolvedCount > 0 && (
            <span
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-sans text-[10px] font-bold"
              style={{
                backgroundColor: 'var(--status-fail-bg)',
                color: 'var(--status-fail-fg)',
                border: '1px solid var(--status-fail-border)',
              }}
              aria-label={`${unresolvedCount} variabel belum terdefinisi`}
            >
              {unresolvedCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
};
