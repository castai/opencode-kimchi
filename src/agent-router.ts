import type { ModelTier } from "./model-registry.js";

export interface AgentRouting {
  tier: ModelTier;
  isPrimary: boolean;
}

const KNOWN_AGENTS: Record<string, AgentRouting> = {
  "kimchi-auto": { tier: "coding", isPrimary: true },
  build:         { tier: "coding", isPrimary: true },
  plan:          { tier: "reasoning", isPrimary: true },

  general:       { tier: "coding", isPrimary: false },
  explore:       { tier: "quick",  isPrimary: false },

  title:         { tier: "quick",  isPrimary: false },
  summary:       { tier: "quick",  isPrimary: false },
  compaction:    { tier: "quick",  isPrimary: false },
};

const SYSTEM_AGENTS = new Set(["title", "summary", "compaction"]);

export function getAgentRouting(agentName: string): AgentRouting | undefined {
  return KNOWN_AGENTS[agentName];
}

export function isSystemAgent(agentName: string): boolean {
  return SYSTEM_AGENTS.has(agentName);
}

export function isPrimaryAgent(agentName: string): boolean {
  return KNOWN_AGENTS[agentName]?.isPrimary ?? false;
}

export function shouldSkipClassification(agentName: string): boolean {
  const routing = KNOWN_AGENTS[agentName];
  if (!routing) return false;
  return !routing.isPrimary;
}

const DELEGATION_GUIDANCE =
  "You are an ORCHESTRATOR. Default action: DELEGATE via task(description, subagent_type, prompt). " +
  "All three params required. Direct tool use only for <10 line single-file edits or coordination.";

export function getDelegationGuidance(): string {
  return DELEGATION_GUIDANCE;
}

const TASK_TOOL_ENHANCEMENT =
  "DELEGATE via task(). Required params: description (3-5 words), subagent_type (\"explore\" or \"general\"), prompt (instructions). " +
  "Example: task(description=\"Fix auth bug\", subagent_type=\"general\", prompt=\"Fix the auth validation in src/auth.ts...\"). " +
  "Use explore for search/find, general for implementation/research. Verify results after.";

export function getTaskToolEnhancement(): string {
  return TASK_TOOL_ENHANCEMENT;
}
