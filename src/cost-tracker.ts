import type { ModelTier } from "./model-registry.js";

export interface SessionCost {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  messageCount: number;
  costByTier: Record<ModelTier, number>;
  messagesByTier: Record<ModelTier, number>;
  costByAgent: Record<string, number>;
  messagesByAgent: Record<string, number>;
  costByModel: Record<string, number>;
  messagesByModel: Record<string, number>;
  tokensByModel: Record<string, { input: number; output: number }>;
}

interface MessageSnapshot {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  tier: ModelTier;
  agent?: string;
  model?: string;
}

interface SessionTracker {
  cost: SessionCost;
  seen: Map<string, MessageSnapshot>;
}

const sessions = new Map<string, SessionTracker>();
const MAX_COST_SESSIONS = 200;

function emptySessionCost(): SessionCost {
  return {
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    messageCount: 0,
    costByTier: { reasoning: 0, coding: 0, quick: 0 },
    messagesByTier: { reasoning: 0, coding: 0, quick: 0 },
    costByAgent: {},
    messagesByAgent: {},
    costByModel: {},
    messagesByModel: {},
    tokensByModel: {},
  };
}

function getTracker(sessionID: string): SessionTracker {
  let tracker = sessions.get(sessionID);
  if (!tracker) {
    if (sessions.size >= MAX_COST_SESSIONS) {
      const oldest = sessions.keys().next().value!;
      sessions.delete(oldest);
    }
    tracker = { cost: emptySessionCost(), seen: new Map() };
    sessions.set(sessionID, tracker);
  }
  return tracker;
}

export function getSessionCost(sessionID: string): SessionCost {
  return getTracker(sessionID).cost;
}

/**
 * Record or update cost for a message. Deduplicates by messageID —
 * if the same message is updated (streaming), the previous values
 * are subtracted before adding the new ones.
 */
export function recordMessageCost(
  sessionID: string,
  messageID: string,
  tier: ModelTier,
  cost: number,
  inputTokens: number,
  outputTokens: number,
  agent?: string,
  model?: string,
): void {
  cost = Math.max(0, cost);
  inputTokens = Math.max(0, inputTokens);
  outputTokens = Math.max(0, outputTokens);

  const tracker = getTracker(sessionID);
  const session = tracker.cost;
  const prev = tracker.seen.get(messageID);

  if (prev) {
    session.totalCost -= prev.cost;
    session.totalInputTokens -= prev.inputTokens;
    session.totalOutputTokens -= prev.outputTokens;
    session.costByTier[prev.tier] -= prev.cost;
    session.messagesByTier[prev.tier]--;
    session.messageCount--;
    if (prev.agent) {
      session.costByAgent[prev.agent] = (session.costByAgent[prev.agent] ?? 0) - prev.cost;
      session.messagesByAgent[prev.agent] = (session.messagesByAgent[prev.agent] ?? 0) - 1;
    }
    if (prev.model) {
      session.costByModel[prev.model] = (session.costByModel[prev.model] ?? 0) - prev.cost;
      session.messagesByModel[prev.model] = (session.messagesByModel[prev.model] ?? 0) - 1;
      const prevTokens = session.tokensByModel[prev.model];
      if (prevTokens) {
        prevTokens.input -= prev.inputTokens;
        prevTokens.output -= prev.outputTokens;
      }
    }
  }

  session.totalCost += cost;
  session.totalInputTokens += inputTokens;
  session.totalOutputTokens += outputTokens;
  session.messageCount++;
  session.costByTier[tier] += cost;
  session.messagesByTier[tier]++;
  if (agent) {
    session.costByAgent[agent] = (session.costByAgent[agent] ?? 0) + cost;
    session.messagesByAgent[agent] = (session.messagesByAgent[agent] ?? 0) + 1;
  }
  if (model) {
    session.costByModel[model] = (session.costByModel[model] ?? 0) + cost;
    session.messagesByModel[model] = (session.messagesByModel[model] ?? 0) + 1;
    if (!session.tokensByModel[model]) {
      session.tokensByModel[model] = { input: 0, output: 0 };
    }
    session.tokensByModel[model].input += inputTokens;
    session.tokensByModel[model].output += outputTokens;
  }

  tracker.seen.set(messageID, { cost, inputTokens, outputTokens, tier, agent, model });
}

export function estimateSavings(
  sessionCost: SessionCost,
  mostExpensiveInputPer1M: number,
  mostExpensiveOutputPer1M: number,
): number {
  const wouldHaveCost =
    (sessionCost.totalInputTokens / 1_000_000) * mostExpensiveInputPer1M +
    (sessionCost.totalOutputTokens / 1_000_000) * mostExpensiveOutputPer1M;
  return Math.max(0, wouldHaveCost - sessionCost.totalCost);
}

export function formatSessionCost(
  sessionCost: SessionCost,
  savings: number,
): string {
  const lines: string[] = [];
  lines.push(`Session cost: $${sessionCost.totalCost.toFixed(4)} (${sessionCost.messageCount} messages)`);

  if (savings > 0) {
    const wouldHaveCost = sessionCost.totalCost + savings;
    const pct = wouldHaveCost > 0 ? Math.round((savings / wouldHaveCost) * 100) : 0;
    lines.push(`Estimated savings: $${savings.toFixed(4)} (${pct}% cheaper than all-reasoning)`);
  }

  const tierBreakdown = (["reasoning", "coding", "quick"] as const)
    .filter((t) => sessionCost.messagesByTier[t] > 0)
    .map((t) => `${sessionCost.messagesByTier[t]} ${t}`)
    .join(", ");
  if (tierBreakdown) {
    lines.push(`Routing: ${tierBreakdown}`);
  }

  const agentEntries = Object.entries(sessionCost.messagesByAgent)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (agentEntries.length > 0) {
    const agentBreakdown = agentEntries
      .map(([agent, count]) => `${count} ${agent} ($${(sessionCost.costByAgent[agent] ?? 0).toFixed(4)})`)
      .join(", ");
    lines.push(`Agents: ${agentBreakdown}`);
  }

  return lines.join("\n");
}

export function _resetAllCosts(): void {
  sessions.clear();
}
