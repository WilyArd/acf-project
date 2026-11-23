import React, { useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { CheckIcon, Copy01Icon } from '@hugeicons/core-free-icons';
import { tokenizeJsonLine, type JsonValueTokenType } from '../lib/jsonFormat';

interface JsonBodyViewerProps {
  prettyText: string;
  wrapLines: boolean;
}

const MAX_HIGHLIGHT_LINES = 2500;

const VALUE_COLOR_MAP: Record<JsonValueTokenType, string> = {
  string: 'var(--json-string)',
  number: 'var(--json-number)',
  boolean: 'var(--json-boolean)',
  null: 'var(--json-null)',
  punct: 'var(--text-secondary)',
};

function getValueColor(type: JsonValueTokenType): string {
  return VALUE_COLOR_MAP[type];
}

export const JsonBodyViewer: React.FC<JsonBodyViewerProps> = ({ prettyText, wrapLines }) => {
  const [copiedLineIndex, setCopiedLineIndex] = useState<number | null>(null);

  const lines = useMemo(() => (prettyText ? prettyText.split('\n') : []), [prettyText]);
  const tooLargeForHighlight = lines.length > MAX_HIGHLIGHT_LINES;

  const parsedLines = useMemo(
    () => (tooLargeForHighlight ? [] : lines.map((line) => tokenizeJsonLine(line))),
    [lines, tooLargeForHighlight],
  );

  const handleCopyLineValue = async (lineIdx: number, val: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedLineIndex(lineIdx);
      window.setTimeout(() => {
        setCopiedLineIndex((prev) => (prev === lineIdx ? null : prev));
      }, 1500);
    } catch {
      // Clipboard unavailable
    }
  };

  if (lines.length === 0) {
    return (
      <div className="p-3.5 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
        (Body response kosong)
      </div>
    );
  }

  if (tooLargeForHighlight) {
    return (
      <div className="max-h-[420px] overflow-auto">
        <div
          className="border-b px-3.5 py-1.5 text-[11px]"
          style={{
            backgroundColor: 'var(--surface-recessed)',
            borderColor: 'var(--border-hairline)',
            color: 'var(--text-muted)',
          }}
        >
          Mode performa ({lines.length.toLocaleString('id-ID')} baris): pewarnaan sintaks JSON dilewati agar tetap responsif.
        </div>
        <pre
          className={`p-3.5 font-mono text-xs leading-relaxed ${
            wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
          }`}
          style={{ color: 'var(--text-primary)' }}
        >
          <code>{prettyText}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className={`max-h-[440px] py-2 font-mono text-xs leading-relaxed ${
        wrapLines ? 'overflow-x-hidden overflow-y-auto' : 'overflow-auto'
      }`}
    >
      {parsedLines.map((tok, idx) => {
        const isCopied = copiedLineIndex === idx;

        return (
          <div
            key={idx}
            className="group flex items-start gap-2 px-3 py-0.5 transition-colors hover:bg-[var(--surface-hover)]"
          >
            <span
              aria-hidden="true"
              className="w-8 shrink-0 select-none text-right text-[11px] leading-relaxed"
              style={{ color: 'var(--text-muted)', opacity: 0.65 }}
            >
              {idx + 1}
            </span>

            <div
              className={`min-w-0 flex-1 ${
                wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
              }`}
            >
              {tok.indent}
              {tok.keyToken && (
                <>
                  <span style={{ color: 'var(--json-key)' }}>{tok.keyToken}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{tok.colonSep}</span>
                </>
              )}
              <span style={{ color: getValueColor(tok.valueType) }}>{tok.valueToken}</span>
              {tok.comma && <span style={{ color: 'var(--text-secondary)' }}>{tok.comma}</span>}
            </div>

            {tok.copyValue !== null && (
              <button
                type="button"
                onClick={() => void handleCopyLineValue(idx, tok.copyValue!)}
                title={
                  tok.keyToken
                    ? `Salin nilai ${tok.keyToken.replace(/^"|"$/g, '')}`
                    : 'Salin nilai'
                }
                aria-label={
                  tok.keyToken
                    ? `Salin nilai ${tok.keyToken.replace(/^"|"$/g, '')}`
                    : 'Salin nilai baris'
                }
                className={`inline-flex shrink-0 select-none items-center gap-1 rounded border px-1.5 py-0.5 font-sans text-[10px] font-semibold transition-opacity ${
                  isCopied
                    ? 'opacity-95'
                    : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-95 focus-visible:pointer-events-auto focus-visible:opacity-100'
                }`}
                style={{
                  backgroundColor: isCopied ? 'var(--status-pass-bg)' : 'var(--surface-recessed)',
                  borderColor: isCopied ? 'var(--status-pass-border)' : 'var(--border-control)',
                  color: isCopied ? 'var(--status-pass-fg)' : 'var(--text-secondary)',
                }}
              >
                <HugeiconsIcon
                  icon={isCopied ? CheckIcon : Copy01Icon}
                  size={11}
                  strokeWidth={1.8}
                />
                <span>{isCopied ? 'Tersalin' : 'Salin'}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
