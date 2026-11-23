export type JsonValueTokenType = 'string' | 'number' | 'boolean' | 'null' | 'punct';

export interface ParsedJsonLine {
  indent: string;
  keyToken: string | null;
  colonSep: string | null;
  valueType: JsonValueTokenType;
  valueToken: string;
  comma: string;
  copyValue: string | null;
}

export interface ResolvedResponseBody {
  isJson: boolean;
  parsed: unknown;
  prettyText: string;
  rawText: string;
}

export function resolveResponseBody(raw: unknown): ResolvedResponseBody {
  if (raw === undefined) {
    return { isJson: false, parsed: undefined, prettyText: '', rawText: '' };
  }
  if (raw === null) {
    return { isJson: false, parsed: null, prettyText: 'null', rawText: 'null' };
  }

  if (typeof raw === 'object') {
    try {
      return {
        isJson: true,
        parsed: raw,
        prettyText: JSON.stringify(raw, null, 2),
        rawText: JSON.stringify(raw),
      };
    } catch {
      const fallback = String(raw);
      return { isJson: false, parsed: raw, prettyText: fallback, rawText: fallback };
    }
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') {
          return {
            isJson: true,
            parsed,
            prettyText: JSON.stringify(parsed, null, 2),
            rawText: raw,
          };
        }
      } catch {
        // Keep raw string when not valid JSON object/array
      }
    }
    return { isJson: false, parsed: raw, prettyText: raw, rawText: raw };
  }

  const text = String(raw);
  return { isJson: false, parsed: raw, prettyText: text, rawText: text };
}

function classifyValueCore(core: string): {
  valueType: JsonValueTokenType;
  copyValue: string | null;
} {
  if (core.startsWith('"') && core.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(core);
      return {
        valueType: 'string',
        copyValue: typeof decoded === 'string' ? decoded : core.slice(1, -1),
      };
    } catch {
      return { valueType: 'string', copyValue: core.slice(1, -1) };
    }
  }
  if (core === 'true' || core === 'false') {
    return { valueType: 'boolean', copyValue: core };
  }
  if (core === 'null') {
    return { valueType: 'null', copyValue: 'null' };
  }
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(core)) {
    return { valueType: 'number', copyValue: core };
  }
  return { valueType: 'punct', copyValue: null };
}

export function tokenizeJsonLine(line: string): ParsedJsonLine {
  const indentMatch = line.match(/^(\s*)(.*)$/);
  const indent = indentMatch ? indentMatch[1] : '';
  const rest = indentMatch ? indentMatch[2] : line;

  let keyToken: string | null = null;
  let colonSep: string | null = null;
  let valueSegment = rest;

  const keyMatch = rest.match(/^("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/);
  if (keyMatch) {
    keyToken = keyMatch[1];
    colonSep = keyMatch[2];
    valueSegment = keyMatch[3];
  }

  let comma = '';
  let core = valueSegment;
  if (core.endsWith(',')) {
    comma = ',';
    core = core.slice(0, -1);
  }

  const { valueType, copyValue } = classifyValueCore(core);

  return {
    indent,
    keyToken,
    colonSep,
    valueType,
    valueToken: core,
    comma,
    copyValue,
  };
}
