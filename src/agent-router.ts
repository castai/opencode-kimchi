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
  "DELEGATION CONTRACT: You are an ORCHESTRATOR, not an executor.",
  "MUST NOT: Write code directly, perform file operations, execute bash commands, conduct research.",
  "MUST: Delegate to @explore for codebase search, @general for research, task() for implementation.",
  "MAY ONLY execute directly if: < 10 lines AND single file, OR coordination/synthesis only, OR user explicitly requests.",
  "STOP before every action and check: Can subagent do this? If YES, DELEGATE.",
].join(" ");

export function getDelegationGuidance(): string {
  return DELEGATION_GUIDANCE;
}

const TASK_TOOL_ENHANCEMENT = [
  "DELEGATE implementation work via task() — this is MANDATORY per Delegation Contract.",
  "Each subagent gets its own context window and a cost-optimized model.",
  "Use task() for: implementing features, writing tests, refactoring, fixing bugs.",
  "Use @explore for: finding files, searching patterns, understanding codebase structure.",
  "Use @general for: research, investigation, gathering context from multiple sources.",
  "Write detailed prompts with: TASK, EXPECTED OUTCOME, MUST DO, MUST NOT DO, CONTEXT.",
  "After task completes, VERIFY the result before reporting to user.",
].join(" ");

export function getTaskToolEnhancement(): string {
  return TASK_TOOL_ENHANCEMENT;
}
