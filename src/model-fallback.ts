import type { ModelRegistry, ModelTier, KimchiModel } from "./model-registry.js";

interface SessionError {
  name: string;
  data: {
    message?: string;
    statusCode?: number;
    isRetryable?: boolean;
    responseBody?: string;
    [key: string]: unknown;
  };
}

interface FallbackState {
  failedModelID: string;
  failedTier: ModelTier;
  attemptIndex: number;
  pending: boolean;
}

const NON_RETRYABLE_ERRORS = new Set([
  "ProviderAuthError",
  "MessageAbortedError",
]);

const NON_RETRYABLE_STATUS_CODES = new Set([
  401,
  403,
]);

const MAX_FALLBACK_SESSIONS = 100;

const pendingFallbacks = new Map<string, FallbackState>();
const failedModelsPerSession = new Map<string, Set<string>>();

function evictOldestFallback(): void {
  if (pendingFallbacks.size >= MAX_FALLBACK_SESSIONS) {
    const oldest = pendingFallbacks.keys().next().value!;
    pendingFallbacks.delete(oldest);
    failedModelsPerSession.delete(oldest);
  }
}

export function classifyError(error: SessionError): "retryable" | "non-retryable" {
  if (NON_RETRYABLE_ERRORS.has(error.name)) return "non-retryable";

  if (error.name === "APIError") {
    const status = error.data?.statusCode;
    if (status && NON_RETRYABLE_STATUS_CODES.has(status)) return "non-retryable";
  }

  return "retryable";
}

export function onSessionError(
  sessionID: string,
  error: SessionError,
  currentModelID: string,
  currentTier: ModelTier,
): boolean {
  if (classifyError(error) === "non-retryable") return false;
  if (pendingFallbacks.get(sessionID)?.pending) return false;

  evictOldestFallback();

  let failed = failedModelsPerSession.get(sessionID);
  if (!failed) {
    failed = new Set();
    failedModelsPerSession.set(sessionID, failed);
  }
  failed.add(currentModelID);

  const existing = pendingFallbacks.get(sessionID);
  const attemptIndex = existing ? existing.attemptIndex + 1 : 0;

  pendingFallbacks.set(sessionID, {
    failedModelID: currentModelID,
    failedTier: currentTier,
    attemptIndex,
    pending: true,
  });

  return true;
}

export function getNextFallbackModel(
  sessionID: string,
  registry: ModelRegistry,
): KimchiModel | undefined {
  const state = pendingFallbacks.get(sessionID);
  if (!state || !state.pending) return undefined;

  const failed = failedModelsPerSession.get(sessionID) ?? new Set();

  const sameTierCandidates = registry.getAllForTier(state.failedTier);
  for (const candidate of sameTierCandidates) {
    if (!failed.has(candidate.id)) return candidate;
  }

  const TIER_ESCALATION: Record<ModelTier, ModelTier[]> = {
    quick: ["coding", "reasoning"],
    coding: ["reasoning", "quick"],
    reasoning: ["coding", "quick"],
  };

  for (const fallbackTier of TIER_ESCALATION[state.failedTier]) {
    const candidates = registry.getAllForTier(fallbackTier);
    for (const candidate of candidates) {
      if (!failed.has(candidate.id)) return candidate;
    }
  }

  return undefined;
}

export function consumePendingFallback(sessionID: string): FallbackState | undefined {
  const state = pendingFallbacks.get(sessionID);
  if (!state || !state.pending) return undefined;
  state.pending = false;
  return state;
}

export function hasPendingFallback(sessionID: string): boolean {
  return pendingFallbacks.get(sessionID)?.pending === true;
}

export function clearFallbackState(sessionID: string): void {
  pendingFallbacks.delete(sessionID);
  failedModelsPerSession.delete(sessionID);
}

export function getFailedModels(sessionID: string): Set<string> {
  return failedModelsPerSession.get(sessionID) ?? new Set();
}

export function _resetAllFallbacks(): void {
  pendingFallbacks.clear();
  failedModelsPerSession.clear();
}
