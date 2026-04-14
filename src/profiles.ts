import type { ModelTier, ModelRegistry } from "./model-registry.js";

export type ProfileID =
  | "planner"
  | "coder"
  | "assistant"
  | "debugger"
  | "reviewer"
  | "refactorer";

export interface AgentProfile {
  id: ProfileID;
  tier: ModelTier;
  model: string;
  provider: string;
  systemPrompt: string;
  temperature: number;
  label: string;
}

const TIER_FOR_PROFILE: Record<ProfileID, ModelTier> = {
  planner: "reasoning",
  debugger: "reasoning",
  reviewer: "reasoning",
  coder: "coding",
  refactorer: "coding",
  assistant: "quick",
};

const SYSTEM_PROMPTS: Record<ProfileID, string> = {
  planner: [
    "Mode: planning. Delegate research to @explore, then synthesise a plan.",
    "Break work into phases. Identify risks. Delegate investigation of unknowns.",
    "When ready for implementation, delegate it — do not implement yourself.",
  ].join(" "),

  debugger: [
    "Mode: debugging. Delegate code search to @explore to locate the problem.",
    "Form hypotheses, delegate investigation to verify them.",
    "When you identify the fix, delegate it via task() unless it's <10 lines in one file.",
  ].join(" "),

  reviewer: [
    "Mode: review. Delegate code reading to @explore if needed.",
    "Check for: correctness, security, performance, missing edge cases.",
    "Report findings. Delegate fixes via task() if the user agrees.",
  ].join(" "),

  coder: [
    "Mode: coding. Delegate implementation to subagents via task().",
    "For trivial changes (<10 lines, single file) you may act directly.",
    "Everything else: delegate. Include test requirements in your task() prompt.",
  ].join(" "),

  refactorer: [
    "Mode: refactoring. Delegate the refactoring work via task().",
    "Preserve existing behaviour. One kind of change at a time.",
    "Delegate @explore first to understand current patterns, then delegate the transformation.",
  ].join(" "),

  assistant: [
    "Mode: quick response. Be concise and direct.",
    "For code searches, delegate to @explore.",
    "If the task needs significant code changes, delegate via task().",
  ].join(" "),
};

const TEMPERATURES: Record<ProfileID, number> = {
  planner: 0.3,
  debugger: 0.3,
  reviewer: 0.2,
  coder: 0.2,
  refactorer: 0.2,
  assistant: 0.5,
};

export function resolveProfiles(registry: ModelRegistry): Record<ProfileID, AgentProfile> {
  const profiles = {} as Record<ProfileID, AgentProfile>;

  for (const id of Object.keys(TIER_FOR_PROFILE) as ProfileID[]) {
    const tier = TIER_FOR_PROFILE[id];
    const model = registry.getForTier(tier);

    profiles[id] = {
      id,
      tier,
      model: model?.id ?? "unknown",
      provider: model?.provider ?? "kimchi",
      systemPrompt: SYSTEM_PROMPTS[id],
      temperature: TEMPERATURES[id],
      label: `${id} (${model?.id ?? "unknown"})`,
    };
  }

  return profiles;
}

export function profileForModel(
  modelID: string,
  profiles: Record<ProfileID, AgentProfile>,
): AgentProfile | undefined {
  return Object.values(profiles).find((p) => p.model === modelID);
}
