import React, { useEffect, useRef } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Cancel01Icon, Copy01Icon } from '@hugeicons/core-free-icons';
import type { RequestTabSession } from '../lib/requestTabs';
import { METHOD_COLOR_VAR } from './RequestPanel';

interface RequestTabBarProps {
  tabs: RequestTabSession[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDuplicateTab?: (tabId: string) => void;
  onNewTab: () => void;
}

function getTabStatusColor(tab: RequestTabSession): string | null {
  if (tab.isLoading) return 'var(--brand-tint-border)';
  if (tab.result?.overallStatus === 'PASS') return 'var(--status-pass-fg)';
  if (tab.result?.overallStatus === 'FAIL') return 'var(--status-fail-fg)';
  if (tab.errorResult || tab.validationError || tab.networkError) {
    return 'var(--status-error-fg)';
  }
  return null;
}

export const RequestTabBar: React.FC<RequestTabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onDuplicateTab,
  onNewTab,
}) => {
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeTabId]);

  if (tabs.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Tab request terbuka"
      className="flex min-w-0 items-center gap-1 overflow-x-auto border-b px-2 pt-1.5"
      style={{
        backgroundColor: 'var(--surface-recessed)',
        borderColor: 'var(--border-hairline)',
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.tabId === activeTabId;
        const statusColor = getTabStatusColor(tab);
        const methodShort = tab.method === 'DELETE' ? 'DEL' : tab.method;

        return (
          <div
            key={tab.tabId}
            ref={isActive ? activeRef : undefined}
            className="group flex shrink-0 items-center rounded-t-md border border-b-0 transition-colors"
            style={{
              backgroundColor: isActive ? 'var(--surface-canvas)' : 'var(--surface-elevated)',
              borderColor: 'var(--border-hairline)',
              boxShadow: isActive ? 'inset 0 2px 0 0 var(--brand-tint-border)' : 'none',
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onCloseTab(tab.tabId);
              }
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              title={tab.breadcrumb ? `${tab.method} ${tab.title} — ${tab.breadcrumb}` : tab.title}
              onClick={() => onSelectTab(tab.tabId)}
              className="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left"
              style={{
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              <span
                className="shrink-0 font-mono text-[10px] font-bold"
                style={{ color: METHOD_COLOR_VAR[tab.method] }}
              >
                {methodShort}
              </span>
              <span className="max-w-[140px] truncate text-xs font-medium">{tab.title}</span>
              {statusColor && (
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${tab.isLoading ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: statusColor }}
                />
              )}
            </button>
            {isActive && onDuplicateTab && (
              <button
                type="button"
                aria-label={`Duplikat tab ${tab.title}`}
                title="Duplikat tab ini"
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicateTab(tab.tabId);
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-65 transition-opacity hover:opacity-100"
                style={{ color: 'var(--text-muted)' }}
              >
                <HugeiconsIcon icon={Copy01Icon} size={11} strokeWidth={1.8} />
              </button>
            )}
            <button
              type="button"
              aria-label={`Tutup tab ${tab.title}`}
              title={`Tutup tab ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.tabId);
              }}
              className={`mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity hover:opacity-100 ${
                isActive ? 'opacity-75' : 'opacity-45 group-hover:opacity-85'
              }`}
              style={{ color: 'var(--text-muted)' }}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={onNewTab}
        aria-label="Buka tab request baru"
        title="Buka tab request baru"
        className="mb-1 ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors"
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-hairline)',
          color: 'var(--text-secondary)',
        }}
      >
        <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
      </button>
    </div>
  );
};
