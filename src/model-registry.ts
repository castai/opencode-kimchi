export type ModelTier = "reasoning" | "coding" | "quick";

export interface KimchiModel {
  id: string;
  name: string;
  provider: string;
  tier: ModelTier;
  /** Tokens */
  contextWindow: number;
  /** Tokens */
  maxOutput: number;
  supportsReasoning: boolean;
  supportsImages: boolean;
  /** USD per 1M tokens */
  cost: { input: number; output: number };
}

export interface ConfigModelEntry {
  id?: string;
  name?: string;
  reasoning?: boolean;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context: number;
    input?: number;
    output: number;
  };
  modalities?: {
    input: Array<string>;
    output: Array<string>;
  };
  [key: string]: unknown;
}

interface TierPlacement {
  tier: ModelTier;
  /** Lower = higher priority within the tier */
  priority: number;
}

/**
 * Tier placements for known model IDs. A model can appear in multiple tiers
 * (e.g. kimi-k2.5 is competitive in reasoning, coding, AND quick). The first
 * entry is the model's primary tier (used for the `tier` field on KimchiModel).
 *
 * Only tier + priority are hardcoded. All other metadata comes from config.
 *
 * Reasoning — ranked by SWE-bench, GPQA, AIME:
 *   Opus family > o3 > o4-mini > o3-mini > Gemini 2.5 Pro >
 *   Kimi K2.5 (96% AIME / 76.8% SWE, $0.60/$3.00)
 *
 * Coding — ranked by HumanEval+, SWE-bench, agentic benchmarks:
 *   Sonnet family > GPT-4.1 > Kimi K2.5 (76.8% SWE, $0.60/$3.00) >
 *   Gemini 2.5 Flash > Minimax M2.5 (80.2% SWE, $0.30/$1.20) > GPT-4.1 Mini
 *
 * Quick — ranked by cost-effectiveness:
 *   Minimax M2.5 ($0.30/$1.20) > GPT-4.1 Nano ($0.10/$0.40) >
 *   Gemini 2.0 Flash ($0.10/$0.40) > Kimi K2.5 ($0.60/$3.00) >
 *   Haiku 4.5 ($1/$5)
 */
const MODEL_PLACEMENTS: Record<string, TierPlacement[]> = {
  // ── Anthropic Opus — reasoning ──────────────────────────────────────
  "claude-opus-4-6":                [{ tier: "reasoning", priority: 10 }],
  "claude-opus-4-5-20251101":       [{ tier: "reasoning", priority: 11 }],
  "claude-opus-4-5":                [{ tier: "reasoning", priority: 11 }],
  "claude-opus-4-1-20250805":       [{ tier: "reasoning", priority: 12 }],
  "claude-opus-4-1":                [{ tier: "reasoning", priority: 12 }],
  "claude-opus-4-20250514":         [{ tier: "reasoning", priority: 13 }],
  "claude-opus-4-0":                [{ tier: "reasoning", priority: 13 }],

  // ── OpenAI reasoning models ─────────────────────────────────────────
  "o3":                             [{ tier: "reasoning", priority: 20 }],
  "o3-2025-04-16":                  [{ tier: "reasoning", priority: 20 }],
  "o4-mini":                        [{ tier: "reasoning", priority: 30 }],
  "o4-mini-2025-04-16":             [{ tier: "reasoning", priority: 30 }],
  "o3-mini":                        [{ tier: "reasoning", priority: 40 }],
  "o3-mini-2025-01-31":             [{ tier: "reasoning", priority: 40 }],

  // ── Google reasoning ────────────────────────────────────────────────
  "gemini-2.5-pro":                 [{ tier: "reasoning", priority: 50 }],
  "gemini-2.5-pro-preview-05-06":   [{ tier: "reasoning", priority: 50 }],

  // ── Kimi K2.5: 76.8% SWE, 96% AIME, $0.60/$3.00 — all three tiers
  "kimi-k2.5": [
    { tier: "reasoning", priority: 60 },
    { tier: "coding",    priority: 25 },
    { tier: "quick",     priority: 40 },
  ],

  // ── Anthropic Sonnet — coding ───────────────────────────────────────
  "claude-sonnet-4-6":              [{ tier: "coding", priority: 10 }],
  "claude-sonnet-4-5-20250929":     [{ tier: "coding", priority: 11 }],
  "claude-sonnet-4-5":              [{ tier: "coding", priority: 11 }],
  "claude-sonnet-4-20250514":       [{ tier: "coding", priority: 12 }],
  "claude-sonnet-4-0":              [{ tier: "coding", priority: 12 }],

  // ── OpenAI coding models ────────────────────────────────────────────
  "gpt-4.1":                        [{ tier: "coding", priority: 20 }],
  "gpt-4.1-2025-04-14":             [{ tier: "coding", priority: 20 }],

  // ── Google coding ───────────────────────────────────────────────────
  "gemini-2.5-flash":               [{ tier: "coding", priority: 30 }],
  "gemini-2.5-flash-preview-04-17": [{ tier: "coding", priority: 30 }],

  // ── Minimax M2.5: 80.2% SWE, $0.30/$1.20 — coding and quick tiers
  "minimax-m2.5": [
    { tier: "coding", priority: 40 },
    { tier: "quick",  priority: 10 },
  ],

  // ── OpenAI budget models ────────────────────────────────────────────
  "gpt-4.1-mini":                   [{ tier: "coding", priority: 50 }],
  "gpt-4.1-mini-2025-04-14":        [{ tier: "coding", priority: 50 }],
  "gpt-4.1-nano":                   [{ tier: "quick", priority: 20 }],
  "gpt-4.1-nano-2025-04-14":        [{ tier: "quick", priority: 20 }],

  // ── Google budget ───────────────────────────────────────────────────
  "gemini-2.0-flash":               [{ tier: "quick", priority: 30 }],

  // ── Anthropic Haiku — quick ─────────────────────────────────────────
  "claude-haiku-4-5-20251001":      [{ tier: "quick", priority: 50 }],
  "claude-haiku-4-5":               [{ tier: "quick", priority: 50 }],
};

export class ModelRegistry {
  private available: Map<string, KimchiModel>;
  private tierPriority: Map<ModelTier, KimchiModel[]>;

  constructor() {
    this.available = new Map();
    this.tierPriority = new Map();
  }

  /**
   * Rebuilds tier lists. Models appear in every tier they have a placement for,
   * sorted by priority (lowest first), then cost as tiebreaker.
   */
  private rebuildTierPriority(): void {
    this.tierPriority.clear();
    const grouped = new Map<ModelTier, { model: KimchiModel; priority: number }[]>();

    for (const model of this.available.values()) {
      const placements = MODEL_PLACEMENTS[model.id];
      if (placements) {
        for (const p of placements) {
          const list = grouped.get(p.tier) ?? [];
          list.push({ model, priority: p.priority });
          grouped.set(p.tier, list);
        }
      } else {
        const list = grouped.get(model.tier) ?? [];
        list.push({ model, priority: 999 });
        grouped.set(model.tier, list);
      }
    }

    for (const [tier, entries] of grouped) {
      entries.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (a.model.cost.input + a.model.cost.output) - (b.model.cost.input + b.model.cost.output);
      });
      this.tierPriority.set(tier, entries.map((e) => e.model));
    }
  }

  get(modelId: string): KimchiModel | undefined {
    return this.available.get(modelId);
  }

  getForTier(tier: ModelTier): KimchiModel | undefined {
    return this.tierPriority.get(tier)?.[0];
  }

  getAllForTier(tier: ModelTier): KimchiModel[] {
    return this.tierPriority.get(tier) ?? [];
  }

  all(): KimchiModel[] {
    return Array.from(this.available.values());
  }

  /**
   * Load models from the user's opencode config provider section.
   * Config provides all model metadata; we only add tier + priority from MODEL_PLACEMENTS.
   * Unknown models get tier inferred from their reasoning flag + cost.
   */
  loadFromConfig(providerName: string, models: Record<string, ConfigModelEntry>): void {
    for (const [modelId, entry] of Object.entries(models)) {
      const placements = MODEL_PLACEMENTS[modelId];
      const primaryTier = placements?.[0]?.tier ?? this.inferTier(entry);

      this.available.set(modelId, {
        id: modelId,
        name: entry.name ?? modelId,
        provider: providerName,
        tier: primaryTier,
        contextWindow: entry.limit?.context ?? 128_000,
        maxOutput: entry.limit?.output ?? 32_000,
        supportsReasoning: entry.reasoning ?? false,
        supportsImages: entry.modalities?.input?.includes("image") ?? false,
        cost: {
          input: entry.cost?.input ?? 1.0,
          output: entry.cost?.output ?? 3.0,
        },
      });
    }

    this.rebuildTierPriority();
  }

  /**
   * Infer tier for an unknown model: reasoning flag → reasoning,
   * otherwise cost-based (cheap → quick, mid → coding).
   */
  private inferTier(entry: ConfigModelEntry): ModelTier {
    if (entry.reasoning) return "reasoning";
    const blended = (entry.cost?.input ?? 1.0) + (entry.cost?.output ?? 3.0);
    if (blended <= 2.0) return "quick";
    return "coding";
  }

  applyOverrides(overrides: Partial<Record<ModelTier, string>>): void {
    for (const [tier, modelId] of Object.entries(overrides)) {
      if (!modelId) continue;
      const existing = this.available.get(modelId);
      if (existing) {
        this.available.delete(existing.id);
        this.available.set(modelId, { ...existing, tier: tier as ModelTier });
      }
    }
    this.rebuildTierPriority();
  }

  getMostExpensiveModel(): KimchiModel | undefined {
    let most: KimchiModel | undefined;
    let highestCost = 0;
    for (const model of this.available.values()) {
      const blended = model.cost.input + model.cost.output;
      if (blended > highestCost) {
        highestCost = blended;
        most = model;
      }
    }
    return most;
  }
}

export { MODEL_PLACEMENTS };
