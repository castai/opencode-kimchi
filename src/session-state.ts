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

export interface SessionActivity {
  filesModified: Set<string>;
  filesRead: Set<string>;
  toolErrors: string[];
  directToolCalls: number;
  delegationToolCalls: number;
  reminderInjected: boolean;
}

export interface SessionState {
  override: ManualOverride | null;
  nextTierSuggestion: ModelTier | null;
  activeProfile: ProfileID | null;
  activeAgent: string | null;
  selectedModel: string | null;
  signals: ConversationSignals | null;
  liveSignals: LiveSignals;
  activity: SessionActivity;
  history: RoutingDecision[];
  estimatedContextTokens: number;
}

const sessions = new Map<string, SessionState>();

const MAX_SESSIONS = 200;
const MAX_HISTORY = 20;

function defaultActivity(): SessionActivity {
  return {
    filesModified: new Set(),
    filesRead: new Set(),
    toolErrors: [],
    directToolCalls: 0,
    delegationToolCalls: 0,
    reminderInjected: false,
  };
}

function defaultState(): SessionState {
  return {
    override: null,
    nextTierSuggestion: null,
    activeProfile: null,
    activeAgent: null,
    selectedModel: null,
    signals: null,
    liveSignals: { edits: 0, reads: 0, errors: 0 },
    activity: defaultActivity(),
    history: [],
    estimatedContextTokens: 0,
  };
}

export function getSession(sessionID: string): SessionState {
  let state = sessions.get(sessionID);
  if (!state) {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value!;
      sessions.delete(oldest);
    }
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

export function setSelectedModel(sessionID: string, model: string | null): void {
  const state = getSession(sessionID);
  state.selectedModel = model;
}

export function getSelectedModel(sessionID: string): string | null {
  const state = sessions.get(sessionID);
  return state?.selectedModel ?? null;
}

export function clearSelectedModel(sessionID: string): void {
  const state = sessions.get(sessionID);
  if (state) {
    state.selectedModel = null;
  }
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

const MAX_TRACKED_FILES = 50;
const MAX_TOOL_ERRORS = 10;

export function trackFileModified(sessionID: string, filePath: string): void {
  const state = getSession(sessionID);
  if (state.activity.filesModified.size < MAX_TRACKED_FILES) {
    state.activity.filesModified.add(filePath);
  }
}

export function trackFileRead(sessionID: string, filePath: string): void {
  const state = getSession(sessionID);
  if (state.activity.filesRead.size < MAX_TRACKED_FILES) {
    state.activity.filesRead.add(filePath);
  }
}

export function trackToolError(sessionID: string, errorSnippet: string): void {
  const state = getSession(sessionID);
  if (state.activity.toolErrors.length < MAX_TOOL_ERRORS) {
    state.activity.toolErrors.push(errorSnippet.slice(0, 200));
  }
}

export function trackDirectToolCall(sessionID: string): void {
  const state = getSession(sessionID);
  state.activity.directToolCalls++;
}

export function trackDelegationToolCall(sessionID: string): void {
  const state = getSession(sessionID);
  state.activity.delegationToolCalls++;
  state.activity.reminderInjected = false;
}

export function shouldInjectDelegationReminder(sessionID: string): boolean {
  const state = sessions.get(sessionID);
  if (!state) return false;
  if (state.activity.reminderInjected) return false;
  if (state.activity.delegationToolCalls > 0) return false;
  return state.activity.directToolCalls >= 3;
}

export function getDelegationRatio(sessionID: string): { direct: number; delegated: number } {
  const state = sessions.get(sessionID);
  if (!state) return { direct: 0, delegated: 0 };
  return {
    direct: state.activity.directToolCalls,
    delegated: state.activity.delegationToolCalls,
  };
}

export function markReminderInjected(sessionID: string): void {
  const state = sessions.get(sessionID);
  if (state) state.activity.reminderInjected = true;
}

export function updateContextEstimate(sessionID: string, inputTokens: number): void {
  const state = getSession(sessionID);
  if (inputTokens > state.estimatedContextTokens) {
    state.estimatedContextTokens = inputTokens;
  }
}

export function resetContextEstimate(sessionID: string): void {
  const state = sessions.get(sessionID);
  if (state) {
    state.estimatedContextTokens = 0;
  }
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
