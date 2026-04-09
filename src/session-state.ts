import type { ProfileID } from "./profiles.js";
import type { ModelTier } from "./model-registry.js";

export interface ManualOverride {
  profile: ProfileID;
  sticky: boolean;
}

export interface RoutingDecision {
  profile: ProfileID;
  source: string;
  timestamp: number;
}

export interface ConversationSignals {
  recentToolCalls: number;
  recentEditToolCalls: number;
  recentReadToolCalls: number;
  avgUserMsgLength: number;
  avgAssistantMsgLength: number;
  codeBlockCount: number;
  errorMentions: number;
  totalMessages: number;
}

export interface LiveSignals {
  edits: number;
  reads: number;
  errors: number;
}

export interface SessionState {
  override: ManualOverride | null;
  nextTierSuggestion: ModelTier | null;
  activeProfile: ProfileID | null;
  activeAgent: string | null;
  signals: ConversationSignals | null;
  liveSignals: LiveSignals;
  history: RoutingDecision[];
}

const sessions = new Map<string, SessionState>();

const MAX_HISTORY = 20;

function defaultState(): SessionState {
  return {
    override: null,
    nextTierSuggestion: null,
    activeProfile: null,
    activeAgent: null,
    signals: null,
    liveSignals: { edits: 0, reads: 0, errors: 0 },
    history: [],
  };
}

export function getSession(sessionID: string): SessionState {
  let state = sessions.get(sessionID);
  if (!state) {
    state = defaultState();
    sessions.set(sessionID, state);
  }
  return state;
}

export function setOverride(sessionID: string, override: ManualOverride | null): void {
  const state = getSession(sessionID);
  state.override = override;
}

export function consumeOneShotOverride(sessionID: string): ManualOverride | null {
  const state = getSession(sessionID);
  if (!state.override) return null;
  const override = state.override;
  if (!override.sticky) {
    state.override = null;
  }
  return override;
}

export function setNextTierSuggestion(sessionID: string, tier: ModelTier | null): void {
  const state = getSession(sessionID);
  state.nextTierSuggestion = tier;
}

export function consumeNextTierSuggestion(sessionID: string): ModelTier | null {
  const state = getSession(sessionID);
  const suggestion = state.nextTierSuggestion;
  state.nextTierSuggestion = null;
  return suggestion;
}

export function setActiveProfile(sessionID: string, profile: ProfileID): void {
  const state = getSession(sessionID);
  state.activeProfile = profile;
}

export function setActiveAgent(sessionID: string, agent: string | null): void {
  const state = getSession(sessionID);
  state.activeAgent = agent;
}

export function updateSignals(sessionID: string, signals: ConversationSignals): void {
  const state = getSession(sessionID);
  state.signals = signals;
}

export function incrementLiveSignal(
  sessionID: string,
  signal: keyof LiveSignals,
  amount = 1,
): void {
  const state = getSession(sessionID);
  state.liveSignals[signal] += amount;
}

export function recordDecision(sessionID: string, decision: Omit<RoutingDecision, "timestamp">): void {
  const state = getSession(sessionID);
  state.history.push({ ...decision, timestamp: Date.now() });
  if (state.history.length > MAX_HISTORY) {
    state.history.shift();
  }
}

export function clearSession(sessionID: string): void {
  sessions.delete(sessionID);
}

export function _resetAll(): void {
  sessions.clear();
}
