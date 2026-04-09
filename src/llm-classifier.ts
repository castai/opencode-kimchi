import type { ModelTier } from "./model-registry.js";

const VALID_TIERS = new Set<ModelTier>(["reasoning", "coding", "quick"]);

const CLASSIFICATION_PROMPT = `Classify this user message into exactly one category based on what the user needs.

Categories:
- reasoning: Architecture design, planning, trade-off analysis, debugging complex issues, code review, security audit, research
- coding: Writing code, implementing features, refactoring, writing tests, fixing bugs with known cause
- quick: Simple questions, lookups, explanations, summaries, confirmations, codebase navigation

Respond with ONLY the category name (reasoning, coding, or quick). No explanation.

Message:
`;

export interface LlmClassifierOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export async function classifyWithLlm(
  text: string,
  options: LlmClassifierOptions,
): Promise<ModelTier | null> {
  try {
    const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "user", content: CLASSIFICATION_PROMPT + text.slice(0, 500) },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (!raw) return null;

    // Extract the tier from the response — handle models that might add extra text
    for (const tier of VALID_TIERS) {
      if (raw === tier || raw.startsWith(tier)) {
        return tier;
      }
    }

    return null;
  } catch {
    return null;
  }
}
