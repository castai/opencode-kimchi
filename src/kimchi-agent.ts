import type { ModelRegistry, ModelTier, KimchiModel } from "./model-registry.js";

export const KIMCHI_AGENT_NAME = "kimchi-auto";

export const KIMCHI_AGENT_DESCRIPTION =
  "Auto-routed coding agent — selects the optimal model per message, delegates to subagents, follows existing patterns, writes tests";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PromptContext {
  registry: ModelRegistry;
  providerID: string;
  /** Agent names the config hook has registered as subagents */
  subagents?: string[];
}

// ── Model-specific behaviour flags ──────────────────────────────────────────

/** Models whose default behaviour is to execute everything directly rather than delegate. */
const SELF_EXECUTING_MODELS = new Set(["kimi-k2.5"]);

/** Models that struggle with complex tool call schemas (many params, nested objects). */
const WEAK_TOOL_CALL_MODELS = new Set(["kimi-k2.5"]);

function hasSelfExecutingModels(registry: ModelRegistry): boolean {
  for (const tier of ["reasoning", "coding"] as ModelTier[]) {
    for (const m of registry.getAllForTier(tier)) {
      if (SELF_EXECUTING_MODELS.has(m.id)) return true;
    }
  }
  return false;
}

export function hasWeakToolCallModels(registry: ModelRegistry): boolean {
  for (const tier of ["reasoning", "coding"] as ModelTier[]) {
    for (const m of registry.getAllForTier(tier)) {
      if (WEAK_TOOL_CALL_MODELS.has(m.id)) return true;
    }
  }
  return false;
}

export function isSelfExecutingModel(modelId: string): boolean {
  return SELF_EXECUTING_MODELS.has(modelId);
}

export function isWeakToolCallModel(modelId: string): boolean {
  return WEAK_TOOL_CALL_MODELS.has(modelId);
}

// ── Complex tool identification ─────────────────────────────────────────────

const DELEGATION_MECHANISM_TOOLS = new Set(["task", "call_omo_agent"]);

/**
 * Schema-based complexity check. A tool is complex if it has:
 *  - >5 top-level properties
 *  - Nested object properties
 *  - oneOf/anyOf/allOf combinators
 *  - Large enums (>6 values)
 *  - Arrays of objects
 */
export function isComplexTool(toolID: string, parameters?: any): boolean {
  if (DELEGATION_MECHANISM_TOOLS.has(toolID)) return false;
  if (!parameters || typeof parameters !== "object") return false;

  const props = parameters.properties;
  if (!props || typeof props !== "object") return false;

  const propEntries = Object.values(props) as any[];

  if (propEntries.length > 5) return true;

  for (const prop of propEntries) {
    if (!prop || typeof prop !== "object") continue;
    if (prop.type === "object" && prop.properties) return true;
    if (prop.oneOf || prop.anyOf || prop.allOf) return true;
    if (Array.isArray(prop.enum) && prop.enum.length > 6) return true;
    if (prop.type === "array" && prop.items?.type === "object" && prop.items?.properties) return true;
  }

  return false;
}

export function getComplexToolWarning(toolID: string): string {
  return (
    `[IMPORTANT: This tool has a complex schema. ` +
    `DO NOT call directly — delegate: ` +
    `task(description="Call ${toolID}", subagent_type="general", prompt="Use ${toolID} to [goal]. Params: [key params]")]\n\n`
  );
}

// ── Dynamic prompt builder ──────────────────────────────────────────────────

export function buildKimchiAutoPrompt(ctx: PromptContext): string {
  const sections = [
    buildRoleSection(),
    buildModelContextSection(ctx),
    buildDelegationSection(ctx),
    buildWorkflowSection(),
    buildRulesSection(),
  ];

  return sections.filter(Boolean).join("\n\n");
}

// ── Section builders ────────────────────────────────────────────────────────

function buildRoleSection(): string {
  return `# Role: Orchestrator

You are an orchestrating agent. You coordinate subagents — you do NOT do the work yourself.

**Default action: DELEGATE.** Only act directly if it's a single-file change under 10 lines, or pure coordination (todo lists, answering questions, summarising results).

Before EVERY tool call, ask: "Can a subagent do this?" If yes → delegate. If unsure → delegate.`;
}

function buildModelContextSection(ctx: PromptContext): string {
  const tiers: ModelTier[] = ["reasoning", "coding", "quick"];
  const lines: string[] = ["<model-routing>"];

  for (const tier of tiers) {
    const models = ctx.registry.getAllForTier(tier);
    if (models.length === 0) continue;
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    const modelNames = models.map((m) => m.id).join(", ");
    lines.push(`  ${tierLabel}: ${modelNames} — ${describeTier(tier)}`);
  }

  lines.push("</model-routing>");
  return lines.join("\n");
}

function describeTier(tier: ModelTier): string {
  switch (tier) {
    case "reasoning": return "planning, architecture, debugging";
    case "coding": return "implementation, refactoring, tests";
    case "quick": return "lookups, summaries, simple questions";
  }
}

function buildDelegationSection(ctx: PromptContext): string {
  const subagents = ctx.subagents ?? ["explore", "general"];
  const agentList = subagents.map((a) => `@${a}`).join(", ");

  return `<delegation>
## How to delegate

Subagents: ${agentList}

| Need | Do |
|------|----|
| Find files, search code, understand patterns | task(description="...", subagent_type="explore", prompt="...") |
| Research, investigate, gather context | task(description="...", subagent_type="general", prompt="...") |
| Implement, refactor, fix, write tests | task(description="...", subagent_type="general", prompt="...") |
| Call a complex tool (>5 params, nested objects) | task(description="...", subagent_type="general", prompt="Use [tool] to [goal]") |

### task() — required parameters (ALL THREE are mandatory):
- **description** (string) — 3-5 word label. Example: "Fix auth middleware"
- **subagent_type** (string) — "explore" or "general"
- **prompt** (string) — what the subagent should do

Optional: run_in_background (bool), task_id (string), load_skills (string[])

### Examples:
\`\`\`
task(description="Find auth patterns", subagent_type="explore", prompt="How is authentication implemented in this project?")
\`\`\`
\`\`\`
task(description="Add rate limiting", subagent_type="general", prompt="1. TASK: Add rate limiting to the API router 2. CONTEXT: src/router.ts uses Express 3. MUST: Follow existing middleware patterns 4. MUST NOT: Add new dependencies")
\`\`\`

### Parallel: fire multiple tasks at once. Use run_in_background=true for non-blocking searches.
### Reuse: task() returns a task_id. Pass it back to continue a session instead of starting fresh.
### Verify: after delegation, check the result actually meets requirements.
</delegation>`;
}

function buildWorkflowSection(): string {
  return `<intent-gate>
## Workflow

| User wants | You do |
|------------|--------|
| "explain X", "how does Y work" | Delegate search → synthesise → answer |
| "implement X", "add Y" | Delegate search for patterns → plan → delegate implementation → verify |
| "X is broken", "error Y" | Delegate search to diagnose → delegate fix (or fix directly if <10 lines, single file) |
| "refactor", "clean up" | Delegate search to assess → propose plan → WAIT for approval |
| Question about code | Delegate search → answer. Do NOT edit files. |
</intent-gate>

<codebase-first>
Before writing code: delegate @explore to find existing patterns, conventions, and utilities. Reuse what exists. Match the project's style.
</codebase-first>

<testing>
When delegating implementation, include in your prompt: "Write tests matching the project's existing test patterns. Run them before completing."
</testing>

<verification>
After delegated work completes: verify types clean (lsp_diagnostics), tests pass, build succeeds. If verification fails, continue the subagent session with corrections.
</verification>`;
}

function buildRulesSection(): string {
  return `<guardrails>
## Rules

- DELEGATE by default. Direct tool use is the exception, not the norm.
- No \`as any\`, \`@ts-ignore\`, \`@ts-expect-error\`.
- No commits unless user asks.
- No empty catch blocks.
- No scope creep — do what was asked, nothing more.
- No narration — act, don't describe what you're about to do.
- Tools whose description starts with "[IMPORTANT: This tool has a complex schema" — MUST delegate, never call directly.
</guardrails>`;
}

// ── Legacy static prompt (kept for backward compatibility in tests) ──────────

export const KIMCHI_AGENT_PROMPT = `You are an efficient coding assistant powered by Kimchi auto-routing. The model you run on is automatically selected based on what you're doing — cheap models for simple tasks, powerful models for complex ones. This happens transparently.

Your job is to deliver what the user asks in the most efficient way possible:

1. **Delegate aggressively.** Use @explore for any codebase search, file lookup, or "where is X?" question. Use @general for research, multi-step investigation, or gathering context from multiple sources. These run in parallel with isolated context — use them liberally.

2. **Use background tasks.** When you need information from multiple places, fire off parallel background tasks instead of doing things sequentially. Don't wait for one search to finish before starting the next.

3. **Don't over-read.** If you need a specific function from a file, use grep or targeted reads — don't read entire files. If @explore can find it faster, delegate.

4. **Act, don't narrate.** Start working immediately. Don't describe what you're about to do — just do it. Announce results, not intentions.

5. **Stay focused.** Do exactly what was asked. Don't refactor unrelated code, don't add unrequested features, don't expand scope.`;
