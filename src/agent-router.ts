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
  "When a task involves exploring the codebase, searching for files, or locating definitions, delegate to @explore rather than doing it yourself — it runs on a cheaper model with isolated context.",
  "For research tasks requiring multiple steps or gathering information from several sources, delegate to @general.",
  "Delegation preserves your context window and uses cost-optimized models for focused tasks.",
].join(" ");

export function getDelegationGuidance(): string {
  return DELEGATION_GUIDANCE;
}

const TASK_TOOL_ENHANCEMENT = [
  "Spawn a focused subagent for a specific task.",
  "Delegation is preferred when: the task is self-contained, involves codebase search/exploration, or requires multi-step investigation.",
  "Subagents run in isolated context with cost-optimized models, preserving the main conversation's context window.",
  "Available subagents: @explore (fast read-only codebase search), @general (research and multi-step tasks).",
].join(" ");

export function getTaskToolEnhancement(): string {
  return TASK_TOOL_ENHANCEMENT;
}
