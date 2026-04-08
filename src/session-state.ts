/**
 * Per-session state management.
 *
 * Tracks the current profile, manual overrides, conversation history summary,
 * and routing decisions for each session.
 */

import type { ProfileID } from "./profiles.js";

export interface ManualOverride {
  profile: ProfileID;
  sticky: boolean; // true = locked until /auto, false = one-shot
}

export interface RoutingDecision {
  profile: ProfileID;
  source: string; // e.g. "phase:implementation", "override:plan", "heuristic:coding"
  timestamp: number;
}

export interface ConversationSignals {
  /** Number of tool calls in recent messages */
  recentToolCalls: number;
  /** Number of file-editing tool calls (write, edit, patch, bash) */
  recentEditToolCalls: number;
  /** Number of read-only tool calls (read, glob, grep) */
  recentReadToolCalls: number;
  /** Average length of recent user messages */
  avgUserMsgLength: number;
  /** Average length of recent assistant messages */
  avgAssistantMsgLength: number;
  /** Code block count in recent messages */
  codeBlockCount: number;
  /** Number of messages mentioning errors/exceptions/crashes */
  errorMentions: number;
  /** Total message count in conversation */
  totalMessages: number;
}

export interface SessionState {
  /** Active manual override (slash commands) */
  override: ManualOverride | null;
  /** Profile suggested by LLM self-routing tool for next turn */
  nextProfileSuggestion: ProfileID | null;
  /** Currently active profile (set by chat.message, read by system.transform) */
  activeProfile: ProfileID | null;
  /** Latest conversation signals (updated by messages.transform hook) */
  signals: ConversationSignals | null;
  /** Recent routing decisions (capped at 20) */
  history: RoutingDecision[];
}

const sessions = new Map<string, SessionState>();

const MAX_HISTORY = 20;

function defaultState(): SessionState {
  return {
    override: null,
    nextProfileSuggestion: null,
    activeProfile: null,
    signals: null,
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

export function setNextProfileSuggestion(sessionID: string, profile: ProfileID | null): void {
  const state = getSession(sessionID);
  state.nextProfileSuggestion = profile;
}

export function consumeNextProfileSuggestion(sessionID: string): ProfileID | null {
  const state = getSession(sessionID);
  const suggestion = state.nextProfileSuggestion;
  state.nextProfileSuggestion = null;
  return suggestion;
}

export function setActiveProfile(sessionID: string, profile: ProfileID): void {
  const state = getSession(sessionID);
  state.activeProfile = profile;
}

export function updateSignals(sessionID: string, signals: ConversationSignals): void {
  const state = getSession(sessionID);
  state.signals = signals;
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

/** For testing */
export function _resetAll(): void {
  sessions.clear();
}
