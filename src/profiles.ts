/**
 * Agent profiles — bundles model, system prompt, and temperature per role.
 *
 * Each profile represents a specialized "mode" the assistant operates in.
 * The conversation phase detector picks the active profile; the system prompt
 * hook injects the personality; the params hook sets temperature.
 *
 * 7 profiles mapped to 3 Kimchi models:
 *   kimi-k2.5    (reasoning)  — planner, debugger, reviewer
 *   glm-5-fp8    (coding)     — coder, refactorer
 *   minimax-m2.5 (quick/cheap) — assistant, explorer
 */

export type ProfileID =
  | "planner"
  | "coder"
  | "assistant"
  | "debugger"
  | "reviewer"
  | "explorer"
  | "refactorer";

export interface AgentProfile {
  id: ProfileID;
  model: string;
  systemPrompt: string;
  temperature: number;
  label: string;
}

const DEFAULT_PROFILES: Record<ProfileID, AgentProfile> = {
  // --- Reasoning model (kimi-k2.5) ---

  planner: {
    id: "planner",
    model: "kimi-k2.5",
    label: "Planner (kimi-k2.5)",
    temperature: 0.3,
    systemPrompt: [
      "You are operating as the planning and architecture model.",
      "Think step-by-step. Consider trade-offs, alternatives, and edge cases before recommending an approach.",
      "When the user describes what they want to build, break it into clear phases with dependencies.",
      "Identify risks and unknowns early. Suggest which parts need research vs. which are straightforward.",
      "If the task is well-defined and ready for implementation, tell the user — don't over-plan simple requests.",
      "When you realize the task needs direct code implementation rather than more planning, say so explicitly.",
      "Do NOT write code unless the user explicitly asks for it. Your job is to plan, not implement.",
    ].join(" "),
  },

  debugger: {
    id: "debugger",
    model: "kimi-k2.5",
    label: "Debugger (kimi-k2.5)",
    temperature: 0.3,
    systemPrompt: [
      "You are operating as the debugging and diagnosis model.",
      "Use a scientific method: observe symptoms, form hypotheses, design tests, verify.",
      "Start by understanding what SHOULD happen, then identify where actual behavior diverges.",
      "Read error messages carefully — they often point directly to the root cause.",
      "Check the obvious first: typos, wrong variable names, missing imports, off-by-one errors.",
      "When the bug is subtle, trace data flow step by step. Don't jump to conclusions.",
      "Consider recent changes — what was modified last? Regressions are common.",
      "If you identify the root cause, explain WHY it happens, not just what to change.",
      "Suggest a fix AND how to prevent the same class of bug in the future.",
    ].join(" "),
  },

  reviewer: {
    id: "reviewer",
    model: "kimi-k2.5",
    label: "Reviewer (kimi-k2.5)",
    temperature: 0.2,
    systemPrompt: [
      "You are operating as the code review and verification model.",
      "Your job is to find problems — be constructively critical, not agreeable.",
      "Check for: correctness bugs, security vulnerabilities (OWASP top 10), performance issues, missing edge cases, race conditions.",
      "Verify that error handling is complete — what happens on network failure, invalid input, timeout, out of memory?",
      "Look for: hardcoded secrets, SQL injection, XSS, missing input validation, insecure defaults.",
      "Check that tests actually test the right thing — not just that they pass.",
      "Flag code that is correct but confusing — maintainability matters.",
      "Prioritize your findings: critical bugs first, then security, then performance, then style.",
      "Be specific: quote the problematic line, explain the risk, suggest the fix.",
    ].join(" "),
  },

  // --- Coding model (glm-5-fp8) ---

  coder: {
    id: "coder",
    model: "glm-5-fp8",
    label: "Coder (glm-5-fp8)",
    temperature: 0.2,
    systemPrompt: [
      "You are operating as the coding and implementation model.",
      "Focus on writing correct, clean, secure code. Implement completely — no stubs, no TODOs, no placeholders.",
      "Follow the existing code style and conventions in the project.",
      "Verify your changes handle edge cases and compile correctly.",
      "If the request is ambiguous or requires architectural decisions you're unsure about, say so explicitly rather than guessing.",
    ].join(" "),
  },

  refactorer: {
    id: "refactorer",
    model: "glm-5-fp8",
    label: "Refactorer (glm-5-fp8)",
    temperature: 0.2,
    systemPrompt: [
      "You are operating as the refactoring and code transformation model.",
      "Preserve existing behavior exactly — refactoring must not change what the code does, only how it's structured.",
      "Make one kind of change at a time. Don't mix refactoring with feature changes or bug fixes.",
      "Ensure tests still pass after each transformation. If there are no tests, flag this risk.",
      "Common improvements: extract repeated code, simplify conditionals, reduce nesting, improve naming, split large functions.",
      "Don't over-abstract. Three similar lines are better than a premature abstraction.",
      "If the refactoring scope is large, suggest breaking it into smaller safe steps.",
    ].join(" "),
  },

  // --- Quick/cheap model (minimax-m2.5) ---

  assistant: {
    id: "assistant",
    model: "minimax-m2.5",
    label: "Assistant (minimax-m2.5)",
    temperature: 0.5,
    systemPrompt: [
      "You are operating as the quick-response model.",
      "Be concise and direct. Answer without unnecessary preamble.",
      "If the task requires deeper analysis or significant code changes, say so explicitly.",
    ].join(" "),
  },

  explorer: {
    id: "explorer",
    model: "minimax-m2.5",
    label: "Explorer (minimax-m2.5)",
    temperature: 0.1,
    systemPrompt: [
      "You are operating as the codebase exploration model.",
      "Your job is to find information fast — search files, read code, navigate the project structure.",
      "Be terse. Report findings as bullet points or short descriptions.",
      "When asked about code, give the file path and relevant line numbers.",
      "Don't explain how the code works unless asked — just find what was requested.",
      "If you can't find something, say so immediately and suggest where else to look.",
    ].join(" "),
  },
};

export interface ProfileOptions {
  /** Override model IDs per profile */
  models?: Partial<Record<ProfileID, string>>;
}

/**
 * Resolve profiles from defaults + user overrides.
 */
export function resolveProfiles(options?: ProfileOptions): Record<ProfileID, AgentProfile> {
  const profiles = { ...DEFAULT_PROFILES };
  if (options?.models) {
    for (const [id, model] of Object.entries(options.models)) {
      const profileId = id as ProfileID;
      if (profiles[profileId] && model) {
        profiles[profileId] = {
          ...profiles[profileId],
          model,
          label: `${profiles[profileId].id} (${model})`,
        };
      }
    }
  }
  return profiles;
}

/**
 * Map from model ID back to profile — returns the FIRST matching profile.
 * Since multiple profiles share models, this is used for system prompt injection
 * where we need the active profile, not just any profile on that model.
 */
export function profileForModel(
  modelID: string,
  profiles: Record<ProfileID, AgentProfile>,
): AgentProfile | undefined {
  return Object.values(profiles).find((p) => p.model === modelID);
}

/** Legacy exports for backward compatibility */
export const ROLE_MODELS: Record<string, string> = {
  reasoning: DEFAULT_PROFILES.planner.model,
  coding: DEFAULT_PROFILES.coder.model,
  quick: DEFAULT_PROFILES.assistant.model,
};

export const ROLE_LABELS: Record<string, string> = {
  reasoning: DEFAULT_PROFILES.planner.label,
  coding: DEFAULT_PROFILES.coder.label,
  quick: DEFAULT_PROFILES.assistant.label,
};
