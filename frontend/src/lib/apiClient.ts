import type {
  ErrorPayload,
  ExecutePayload,
  ResultPayload,
  ValidationError,
} from '../types/api';

export type ExecuteApiOutcome =
  | { kind: 'result'; data: ResultPayload }
  | { kind: 'error'; data: ErrorPayload }
  | { kind: 'validation'; error: ValidationError }
  | { kind: 'aborted' }
  | { kind: 'network'; message: string };

export async function executeProxyRequest(
  payload: ExecutePayload,
  signal?: AbortSignal,
): Promise<ExecuteApiOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/proxy/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { kind: 'aborted' };
    }
    return {
      kind: 'network',
      message:
        'Backend proxy tidak terjangkau di /api/proxy/execute. Pastikan Fastify berjalan di http://127.0.0.1:3001.',
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      kind: 'network',
      message: `Backend mengembalikan respons non-JSON (HTTP ${response.status}).`,
    };
  }

  if (response.status === 400 || response.status === 403 || response.status === 429) {
    const errObj = (parsed as { error?: ValidationError })?.error;
    return {
      kind: 'validation',
      error: {
        code: errObj?.code ?? 'INVALID_JSON_BODY',
        message: errObj?.message ?? `Permintaan ditolak oleh validasi pra-eksekusi (HTTP ${response.status}).`,
        field: errObj?.field ?? null,
        httpStatus: response.status,
      },
    };
  }

  if (!response.ok) {
    return {
      kind: 'network',
      message: `Terjadi kesalahan tak terduga pada proxy backend (HTTP ${response.status}).`,
    };
  }

  const data = parsed as ResultPayload | ErrorPayload;
  if (data.overallStatus === 'ERROR') {
    return { kind: 'error', data };
  }
  return { kind: 'result', data };
}
