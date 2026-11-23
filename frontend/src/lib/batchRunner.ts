import type {
  AssertionDraft,
  CollectionRequestItem,
  Environment,
  ErrorPayload,
  ExecutePayload,
  HttpMethod,
  KeyValueRow,
  ResultPayload,
  ValidationError,
} from '../types/api';
import { executeProxyRequest, type ExecuteApiOutcome } from './apiClient';
import { INITIAL_ASSERTIONS } from './defaults';
import {
  applyPostResponseVarRulesToEnv,
  upsertTokenIntoEnvironment,
} from './postResponseScripts';
import {
  buildExecutePayload,
  extractAutoToken,
  normalizeUrlPathSlashes,
  substituteTemplate,
} from './variables';

/** Matches backend RATE_LIMIT_MAX (30 requests per minute per IP). */
export const MAX_BATCH_REQUESTS = 30;

export interface BatchCapturedToken {
  path: string;
  value: string;
  origin: string;
}

export interface BatchStepDraft {
  method: HttpMethod;
  url: string;
  queryParams: KeyValueRow[];
  headers: KeyValueRow[];
  bodyText: string;
  assertions: AssertionDraft[];
}

export interface BatchStepInput {
  item: CollectionRequestItem;
  collectionName: string;
  draft?: BatchStepDraft;
}

export type BatchStepStatus =
  | 'queued'
  | 'running'
  | 'pass'
  | 'fail'
  | 'error'
  | 'validation'
  | 'skipped'
  | 'aborted';

export interface BatchStepResult {
  itemId: string;
  name: string;
  collectionName: string;
  folderPath: string[];
  method: HttpMethod;
  urlTemplate: string;
  status: BatchStepStatus;
  statusCode?: number;
  durationMs?: number;
  passedCount: number;
  failedCount: number;
  totalAssertions: number;
  result?: ResultPayload;
  errorResult?: ErrorPayload;
  validationError?: ValidationError;
  clientError?: string;
  networkError?: string;
  resolvedHistoryUrl?: string;
  skipReason?: string;
}

export interface BatchRunSummary {
  steps: BatchStepResult[];
  passCount: number;
  failCount: number;
  errorCount: number;
  validationCount: number;
  skippedCount: number;
  abortedCount: number;
  rateLimited: boolean;
  aborted: boolean;
  finalCapturedToken: BatchCapturedToken | null;
  updatedActiveEnv?: Environment | null;
}

export interface BatchRunOptions {
  steps: BatchStepInput[];
  activeEnv: Environment | null;
  autoSyncEnvToken?: boolean;
  envTokenNeedsBearer?: boolean;
  initialCapturedToken?: BatchCapturedToken | null;
  initialLastResponseBody?: unknown;
  initialLastResponseOrigin?: string;
  allowResponseFallback?: boolean;
  stopOnFailure: boolean;
  delayMs: number;
  signal?: AbortSignal;
  executeFn?: (payload: ExecutePayload, signal?: AbortSignal) => Promise<ExecuteApiOutcome>;
  onStepUpdate?: (index: number, result: BatchStepResult) => void;
}

/** Toggle a single item ID in ordered batch selection while capping at `max`. */
export function toggleBatchSelection(
  currentIds: string[],
  targetId: string,
  max = MAX_BATCH_REQUESTS,
): string[] {
  const existingIdx = currentIds.indexOf(targetId);
  if (existingIdx >= 0) {
    return currentIds.filter((id) => id !== targetId);
  }
  if (currentIds.length >= max) {
    return currentIds;
  }
  return [...currentIds, targetId];
}

/** Toggle all item IDs in a folder; unchecks all if every item is selected, else adds up to `max`. */
export function toggleBatchFolderSelection(
  currentIds: string[],
  folderItemIds: string[],
  max = MAX_BATCH_REQUESTS,
): string[] {
  if (folderItemIds.length === 0) return currentIds;
  const selectedSet = new Set(currentIds);
  const allSelected = folderItemIds.every((id) => selectedSet.has(id));

  if (allSelected) {
    const folderSet = new Set(folderItemIds);
    return currentIds.filter((id) => !folderSet.has(id));
  }

  const next = [...currentIds];
  for (const id of folderItemIds) {
    if (next.length >= max) break;
    if (!selectedSet.has(id)) {
      selectedSet.add(id);
      next.push(id);
    }
  }
  return next;
}

/** Swap an item up (-1) or down (+1) in the sequential execution order. */
export function moveBatchItem(currentIds: string[], index: number, delta: -1 | 1): string[] {
  const targetIndex = index + delta;
  if (index < 0 || index >= currentIds.length || targetIndex < 0 || targetIndex >= currentIds.length) {
    return currentIds;
  }
  const next = [...currentIds];
  const [moved] = next.splice(index, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function createInitialBatchResults(steps: BatchStepInput[]): BatchStepResult[] {
  return steps.slice(0, MAX_BATCH_REQUESTS).map((step) => {
    const effectiveMethod = step.draft?.method ?? step.item.method;
    const effectiveUrl = step.draft?.url ?? step.item.url;
    return {
      itemId: step.item.id,
      name: step.item.name,
      collectionName: step.collectionName,
      folderPath: [...step.item.folderPath],
      method: effectiveMethod,
      urlTemplate: effectiveUrl,
      status: 'queued',
      passedCount: 0,
      failedCount: 0,
      totalAssertions: 0,
    };
  });
}

function resolveTemplateOrigin(rawUrlTemplate: string, activeEnv: Environment | null): string {
  const sub = substituteTemplate(rawUrlTemplate.trim(), activeEnv, null);
  if (sub.unresolved.length > 0) return '';
  const normalized = normalizeUrlPathSlashes(sub.resolved);
  try {
    return new URL(normalized).origin;
  } catch {
    return '';
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute selected collection items strictly one-by-one via POST /api/proxy/execute.
 * Supports origin-scoped token chaining (2xx auto-capture), stopOnFailure, delayMs,
 * AbortSignal cancellation, and automatic stop on 429 RATE_LIMIT_EXCEEDED.
 */
export async function runSequentialBatch(options: BatchRunOptions): Promise<BatchRunSummary> {
  const boundedSteps = options.steps.slice(0, MAX_BATCH_REQUESTS);
  const results = createInitialBatchResults(boundedSteps);
  const executeFn = options.executeFn ?? executeProxyRequest;
  const delayMs = Math.max(0, Math.min(5000, Math.floor(options.delayMs || 0)));

  let workingEnv: Environment | null = options.activeEnv;
  let envUpdated = false;
  let currentToken: BatchCapturedToken | null = options.initialCapturedToken ?? null;
  let currentLastBody: unknown = options.initialLastResponseBody ?? null;
  let currentLastOrigin = options.initialLastResponseOrigin ?? '';
  let currentAllowFallback = options.allowResponseFallback ?? true;
  let rateLimited = false;
  let aborted = false;

  const markRemaining = (startIdx: number, status: 'skipped' | 'aborted', reason: string) => {
    for (let j = startIdx; j < results.length; j += 1) {
      results[j] = {
        ...results[j],
        status,
        skipReason: reason,
      };
      options.onStepUpdate?.(j, results[j]);
    }
  };

  for (let i = 0; i < boundedSteps.length; i += 1) {
    if (options.signal?.aborted) {
      aborted = true;
      markRemaining(i, 'aborted', 'Dibatalkan oleh pengguna.');
      break;
    }

    if (i > 0 && delayMs > 0) {
      const stillActive = await sleepWithAbort(delayMs, options.signal);
      if (!stillActive) {
        aborted = true;
        markRemaining(i, 'aborted', 'Dibatalkan oleh pengguna.');
        break;
      }
    }

    const step = boundedSteps[i];
    const effective: BatchStepDraft = step.draft ?? {
      method: step.item.method,
      url: step.item.url,
      queryParams: step.item.queryParams.map((r) => ({ ...r })),
      headers: step.item.headers.map((r) => ({ ...r })),
      bodyText: step.item.bodyText,
      assertions: INITIAL_ASSERTIONS.map((a) => ({ ...a })),
    };

    results[i] = {
      ...results[i],
      method: effective.method,
      urlTemplate: effective.url,
      status: 'running',
    };
    options.onStepUpdate?.(i, results[i]);

    const stepOrigin = resolveTemplateOrigin(effective.url, workingEnv);
    const scopedToken =
      currentToken && (!currentToken.origin || !stepOrigin || currentToken.origin === stepOrigin)
        ? currentToken
        : null;
    const stepAllowFallback =
      currentAllowFallback &&
      (!currentLastOrigin || !stepOrigin || currentLastOrigin === stepOrigin);

    const built = buildExecutePayload({
      method: effective.method,
      url: effective.url,
      queryParams: effective.queryParams,
      headers: effective.headers,
      bodyText: effective.bodyText,
      assertions: effective.assertions,
      activeEnv: workingEnv,
      lastResponseBody: currentLastBody,
      manualPassthroughToken: scopedToken,
      allowResponseFallback: stepAllowFallback,
    });

    if (!built.ok) {
      results[i] = {
        ...results[i],
        status: 'validation',
        clientError: built.error,
      };
      options.onStepUpdate?.(i, results[i]);
      if (options.stopOnFailure) {
        markRemaining(i + 1, 'skipped', 'Dihentikan karena langkah sebelumnya gagal validasi.');
        break;
      }
      continue;
    }

    let executedOrigin = '';
    try {
      executedOrigin = new URL(built.payload.request.url).origin;
    } catch {
      executedOrigin = '';
    }

    const outcome = await executeFn(built.payload, options.signal);

    if (outcome.kind === 'aborted') {
      aborted = true;
      markRemaining(i, 'aborted', 'Dibatalkan oleh pengguna.');
      break;
    }

    if (outcome.kind === 'network') {
      results[i] = {
        ...results[i],
        status: 'error',
        networkError: outcome.message,
      };
      options.onStepUpdate?.(i, results[i]);
      if (options.stopOnFailure) {
        markRemaining(i + 1, 'skipped', 'Dihentikan karena koneksi ke backend proxy gagal.');
        break;
      }
      continue;
    }

    if (outcome.kind === 'validation') {
      results[i] = {
        ...results[i],
        status: 'validation',
        statusCode: outcome.error.httpStatus,
        validationError: outcome.error,
      };
      options.onStepUpdate?.(i, results[i]);

      if (outcome.error.code === 'RATE_LIMIT_EXCEEDED') {
        rateLimited = true;
        markRemaining(
          i + 1,
          'skipped',
          'Dihentikan otomatis karena mencapai rate limit backend (HTTP 429).',
        );
        break;
      }
      if (options.stopOnFailure) {
        markRemaining(i + 1, 'skipped', 'Dihentikan karena langkah sebelumnya ditolak validasi.');
        break;
      }
      continue;
    }

    if (outcome.kind === 'error') {
      results[i] = {
        ...results[i],
        status: 'error',
        errorResult: outcome.data,
        resolvedHistoryUrl: built.resolvedFullUrl,
      };
      options.onStepUpdate?.(i, results[i]);
      if (options.stopOnFailure) {
        markRemaining(i + 1, 'skipped', 'Dihentikan karena langkah sebelumnya mengalami ERROR.');
        break;
      }
      continue;
    }

    // PASS or FAIL
    const data = outcome.data;
    const passed = data.overallStatus === 'PASS';
    results[i] = {
      ...results[i],
      status: passed ? 'pass' : 'fail',
      statusCode: data.rawResponse.statusCode,
      durationMs: data.rawResponse.responseTimeMs,
      passedCount: data.passedCount,
      failedCount: data.failedCount,
      totalAssertions: data.totalAssertions,
      result: data,
      resolvedHistoryUrl: built.resolvedFullUrl,
    };
    options.onStepUpdate?.(i, results[i]);

    currentLastBody = data.rawResponse.body;
    currentLastOrigin = executedOrigin;
    currentAllowFallback = true;

    if (data.rawResponse.statusCode >= 200 && data.rawResponse.statusCode < 300) {
      const autoToken = extractAutoToken(data.rawResponse.body);
      if (autoToken) {
        currentToken = { ...autoToken, origin: executedOrigin };
      }
      if (workingEnv) {
        if (step.item.postResponseVars && step.item.postResponseVars.length > 0) {
          const applied = applyPostResponseVarRulesToEnv(
            workingEnv,
            step.item.postResponseVars,
            data.rawResponse.body,
            data.rawResponse.statusCode,
          );
          if (applied.applied.length > 0) {
            workingEnv = applied.updatedEnv;
            envUpdated = true;
          }
        } else if (options.autoSyncEnvToken && autoToken) {
          const hasExistingTokenVar = workingEnv.variables.some((v) =>
            ['token', 'access_token', 'jwt', 'auth_token', 'bearer_token'].includes(
              v.key.trim().toLowerCase(),
            ),
          );
          if (hasExistingTokenVar) {
            workingEnv = upsertTokenIntoEnvironment(workingEnv, autoToken.value, {
              withBearerPrefix: options.envTokenNeedsBearer ?? true,
            }).updatedEnv;
            envUpdated = true;
          }
        }
      }
    }

    if (!passed && options.stopOnFailure) {
      markRemaining(i + 1, 'skipped', 'Dihentikan karena langkah sebelumnya FAIL.');
      break;
    }
  }

  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;
  let validationCount = 0;
  let skippedCount = 0;
  let abortedCount = 0;

  for (const r of results) {
    if (r.status === 'pass') passCount += 1;
    else if (r.status === 'fail') failCount += 1;
    else if (r.status === 'error') errorCount += 1;
    else if (r.status === 'validation') validationCount += 1;
    else if (r.status === 'skipped') skippedCount += 1;
    else if (r.status === 'aborted') abortedCount += 1;
  }

  return {
    steps: results,
    passCount,
    failCount,
    errorCount,
    validationCount,
    skippedCount,
    abortedCount,
    rateLimited,
    aborted,
    finalCapturedToken: currentToken,
    ...(envUpdated ? { updatedActiveEnv: workingEnv } : {}),
  };
}
