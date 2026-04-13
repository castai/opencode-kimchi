import type { SessionState } from "./session-state.js";
import type { ModelRegistry, ModelTier } from "./model-registry.js";
import type { AgentProfile } from "./profiles.js";

const PROACTIVE_COMPACTION_THRESHOLD = 0.78;
const COMPACTION_COOLDOWN_MS = 60_000;
const COMPACTION_TIMEOUT_MS = 60_000;
const MAX_COMPACTION_SESSIONS = 100;

interface CompactionState {
  inProgress: Set<string>;
  lastCompactionTime: Map<string, number>;
}

const state: CompactionState = {
  inProgress: new Set(),
  lastCompactionTime: new Map(),
};

export function buildCompactionContext(session: SessionState, profiles: Record<string, AgentProfile>): string[] {
  const lines: string[] = [];

  const activeProfile = session.activeProfile ? profiles[session.activeProfile] : null;
  if (activeProfile) {
    lines.push(`[Active mode: ${activeProfile.id} (${activeProfile.tier} tier, model: ${activeProfile.model})]`);
  }

  if (session.history.length > 0) {
    const recent = session.history.slice(-8).map((h) => h.profile).join(" → ");
    lines.push(`[Routing history: ${recent}]`);
  }

  const modified = Array.from(session.activity.filesModified);
  if (modified.length > 0) {
    lines.push(`[Files modified this session: ${modified.join(", ")}]`);
  }

  const readOnly = Array.from(session.activity.filesRead).filter((f) => !session.activity.filesModified.has(f));
  if (readOnly.length > 0) {
    lines.push(`[Files read (not modified): ${readOnly.slice(0, 20).join(", ")}${readOnly.length > 20 ? ` (+${readOnly.length - 20} more)` : ""}]`);
  }

  const signals = session.liveSignals;
  if (signals.edits > 0 || signals.reads > 0 || signals.errors > 0) {
    lines.push(`[Tool activity: ${signals.edits} edits, ${signals.reads} reads, ${signals.errors} errors]`);
  }

  if (session.activity.toolErrors.length > 0) {
    const recentErrors = session.activity.toolErrors.slice(-3);
    lines.push(`[Recent errors: ${recentErrors.join(" | ")}]`);
  }

  if (session.override) {
    lines.push(`[User override: ${session.override.profile} (${session.override.sticky ? "locked" : "one-shot"})]`);
  }

  if (session.estimatedContextTokens > 0) {
    lines.push(`[Estimated context: ~${Math.round(session.estimatedContextTokens / 1000)}K tokens]`);
  }

  return lines;
}

export function buildCompactionPrompt(): string {
  return `You are summarizing a coding assistant session. Your goal is to produce a summary that lets the conversation continue seamlessly — the user and assistant should lose no important context.

## What to PRESERVE (critical — loss of these breaks continuity):

1. **Goal and current task state** — What is the user trying to accomplish? What step are they on? What's done, what's remaining?

2. **Technical decisions made** — Architecture choices, library selections, API design decisions, trade-offs discussed. Include the reasoning, not just the outcome.

3. **Files and code context** — Which files were created, modified, or read. Key code structures, function signatures, data models that were established. Include file paths.

4. **Discovered patterns and conventions** — Code style, naming conventions, test patterns, project structure, import style, error handling patterns found in the codebase.

5. **Constraints and requirements** — User-specified constraints, explicit "don't do X" instructions, performance requirements, compatibility needs.

6. **Errors and debugging state** — What bugs were found, what was tried, what worked, what didn't. Root causes identified.

7. **Dependencies and environment** — Frameworks, libraries, versions, config that affects the work.

## What to OMIT (saves space without losing continuity):

- Greetings, acknowledgments, "let me look at that" filler
- Full file contents that were read (just note the path and key findings)
- Intermediate failed attempts that led nowhere (unless the failure is informative)
- Tool invocation details (just note what was found/done)
- Verbose error stack traces (just the error message and root cause)

## Format:

Structure the summary with clear sections:
- **Goal**: What the user is trying to accomplish
- **Accomplished**: What's been done so far (be specific — files, functions, tests)
- **In Progress / Remaining**: What's left to do
- **Key Decisions**: Technical choices and their reasoning
- **Codebase Context**: Files, patterns, conventions discovered
- **Constraints**: User requirements, explicit restrictions

Be concise but complete. Every fact should earn its place by being necessary for continuation.`;
}

export function shouldTriggerProactiveCompaction(
  sessionID: string,
  estimatedContextTokens: number,
  registry: ModelRegistry,
  activeProfile: AgentProfile | null,
): boolean {
  if (state.inProgress.has(sessionID)) return false;

  const lastTime = state.lastCompactionTime.get(sessionID);
  if (lastTime && Date.now() - lastTime < COMPACTION_COOLDOWN_MS) return false;

  if (estimatedContextTokens <= 0) return false;

  const tier: ModelTier = activeProfile?.tier ?? "coding";
  const contextLimit = registry.getContextLimit(tier);
  const usageRatio = estimatedContextTokens / contextLimit;

  return usageRatio >= PROACTIVE_COMPACTION_THRESHOLD;
}

export async function triggerProactiveCompaction(
  sessionID: string,
  client: any,
  directory: string,
  logFn: (msg: string) => void,
): Promise<boolean> {
  if (state.inProgress.has(sessionID)) return false;

  if (state.lastCompactionTime.size >= MAX_COMPACTION_SESSIONS) {
    const oldest = state.lastCompactionTime.keys().next().value!;
    state.lastCompactionTime.delete(oldest);
  }

  state.inProgress.add(sessionID);
  state.lastCompactionTime.set(sessionID, Date.now());

  try {
    const summarizePromise = client.session.summarize({
      sessionID,
      directory,
      auto: true,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("compaction timeout")), COMPACTION_TIMEOUT_MS);
    });

    try {
      await Promise.race([summarizePromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    logFn(`proactive compaction completed for session ${sessionID}`);
    return true;
  } catch (err) {
    logFn(`proactive compaction failed: ${err}`);
    return false;
  } finally {
    state.inProgress.delete(sessionID);
  }
}

export function isCompactionInProgress(sessionID: string): boolean {
  return state.inProgress.has(sessionID);
}

export function _resetCompactionState(): void {
  state.inProgress.clear();
  state.lastCompactionTime.clear();
}
