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

const DELEGATION_GUIDANCE = [
  "You are an orchestrator. Your DEFAULT behavior is to DELEGATE work rather than doing it yourself.",
  "Delegate to @explore for codebase searches, file lookups, and pattern discovery — it runs on a cheaper model with isolated context.",
  "Delegate to @general for research tasks requiring multiple steps or gathering information from several sources.",
  "Delegate via task() for implementation work — write a detailed prompt with TASK, EXPECTED OUTCOME, MUST DO, MUST NOT DO, and file paths.",
  "Only do work directly when it's a trivial single-file change. Delegation preserves your context window and uses cost-optimized models.",
].join(" ");

export function getDelegationGuidance(): string {
  return DELEGATION_GUIDANCE;
}

const TASK_TOOL_ENHANCEMENT = [
  "DELEGATE implementation work to a subagent rather than doing it yourself.",
  "This is the PRIMARY way you should execute multi-step work — each subagent gets its own context window and a cost-optimized model.",
  "Use task() for: implementing features, writing tests, refactoring code, fixing bugs across multiple files.",
  "Use @explore for: finding files, searching patterns, understanding codebase structure.",
  "Use @general for: research, investigation, gathering context from multiple sources.",
  "Write a detailed prompt with: TASK, EXPECTED OUTCOME, MUST DO, MUST NOT DO, and CONTEXT (file paths, patterns to follow).",
  "After the task completes, VERIFY the result before reporting to the user.",
].join(" ");

export function getTaskToolEnhancement(): string {
  return TASK_TOOL_ENHANCEMENT;
}
