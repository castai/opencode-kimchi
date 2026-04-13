# opencode-kimchi

Automatic model routing for [OpenCode](https://opencode.ai) using [Cast AI's Kimchi](https://github.com/castai/kimchi) models.

The plugin analyzes each message and routes it to the most cost-effective model tier:

| Tier | When |
|------|------|
| **Reasoning** | Planning, architecture, debugging, code review, security audit |
| **Coding** | Implementation, refactoring, writing tests |
| **Quick** | Simple questions, lookups, summaries, codebase exploration |

The model used for each tier is selected dynamically from whatever models you have configured in your Kimchi provider. The plugin ranks known models by benchmark performance and cost, then picks the best available one per tier. A single model can serve multiple tiers — for example, `kimi-k2.5` is ranked across all three, and `minimax-m2.5` covers both coding and quick.

**Reasoning tier** (ranked by SWE-bench, GPQA, AIME): Claude Opus family → o3 → o4-mini → Kimi K2.5 → o3-mini → Gemini 2.5 Pro

**Coding tier** (ranked by performance/cost): Kimi K2.5 → Claude Sonnet family → GPT-4.1 → Gemini 2.5 Flash → Minimax M2.5 → GPT-4.1 Mini

**Quick tier** (ranked by cost-effectiveness): Kimi K2.5 → Minimax M2.5 → GPT-4.1 Nano → Gemini 2.0 Flash → Claude Haiku

Unknown models are auto-assigned to a tier based on their `reasoning` flag and cost.

## Install

```bash
opencode plugin @castai/opencode-kimchi
```

That's it. The plugin auto-configures itself — no manual provider setup needed.

## How it works

The plugin registers as a Kimchi provider and exposes virtual models:

- **`kimchi/auto`** — Default. Routes each message to the best model automatically.
- **`kimchi/reasoning`** — Always use the reasoning model.
- **`kimchi/coding`** — Always use the coding model.
- **`kimchi/quick`** — Always use the quick/cheap model.

When using `kimchi/auto`, classification uses a cascade approach:

1. **Heuristic classifier** (instant, free) — keyword signals and structural cues handle ~70% of messages with high confidence
2. **LLM classifier** (fast, cheap) — when heuristics are ambiguous, the cheapest Kimchi model (minimax-m2.5) classifies the message in ~100 tokens
3. **Conversation phase detection** — tool usage patterns, message lengths, and structural signals refine routing as the conversation progresses
4. **Live tool tracking** — file edits, reads, and error patterns in tool output feed routing decisions in real-time
5. **Mode stickiness** — once in a mode, stays there unless a high-confidence signal says otherwise
6. **LLM self-routing** — the model itself can suggest switching tiers for the next message

## Agent profiles

Each model tier maps to a specialized agent profile with a tailored system prompt:

| Profile | Tier | Behavior |
|---------|------|----------|
| `planner` | Reasoning | Step-by-step thinking, trade-off analysis, phase breakdown |
| `debugger` | Reasoning | Scientific method: observe → hypothesize → test → verify |
| `reviewer` | Reasoning | Constructive criticism: bugs, security (OWASP), performance, edge cases |
| `coder` | Coding | Complete implementation, no stubs, follows existing conventions |
| `refactorer` | Coding | Behavior-preserving transformations, one change type at a time |
| `assistant` | Quick | Concise and direct, terse answers, file lookups |

Profiles are activated automatically based on routing.

## Orchestration

When running as `kimchi/auto`, the agent operates as an **orchestrator** — it plans, delegates, and verifies rather than doing all work directly:

- Codebase exploration is delegated to `@explore` subagents
- Multi-step research is delegated to `@general` subagents
- Implementation work is delegated via `task()` with detailed prompts
- Direct tool use is reserved for trivial single-file changes (< 20 lines)

The plugin tracks direct vs. delegated tool calls and injects a reminder when the agent starts doing too much work itself instead of delegating.

## Proactive context compaction

When the conversation context exceeds 78% of the model's context window, the plugin automatically triggers a compaction — summarizing the conversation while preserving critical routing state:

- Active mode and routing history
- Files modified and read this session
- Tool activity counts (edits, reads, errors)
- Recent errors and user overrides

This prevents context overflow without losing important session context.

## Model fallback

If a model request fails (rate limit, unavailability, etc.), the plugin automatically falls back to the next best model in the same tier, then across tiers if needed. Fallback state is tracked per session and cleared on success.

## Configuration

```json
{
  "plugin": [
    ["@castai/opencode-kimchi", {
      "provider": "kimchi",
      "verbose": true,
      "models": {
        "reasoning": "claude-opus-4-6",
        "coding": "claude-sonnet-4-6",
        "quick": "minimax-m2.5"
      },
      "telemetry": true
    }]
  ]
}
```

The `models` override is optional — omit it and the plugin will automatically select the best available model per tier from your provider config.

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | `"kimchi"` | Provider ID to route (matches your Kimchi provider config) |
| `verbose` | `false` | Log model selection decisions |
| `models` | *(auto)* | Override model IDs per tier |
| `apiKey` | *(from provider config)* | CastAI API key (auto-read from your Kimchi provider config) |
| `llmBaseUrl` | `https://llm.cast.ai/openai/v1` | LLM endpoint for classifier |
| `llmClassifier` | `true` | Enable LLM fallback classifier for ambiguous messages |
| `llmClassifierThreshold` | `0.5` | Confidence threshold below which LLM classifier is invoked |
| `telemetry` | `false` | Enable usage telemetry (can also be enabled via env var) |

## Telemetry

The plugin can send usage telemetry and productivity metrics to the Kimchi service. This is **opt-in** — telemetry is only active when explicitly enabled.

### Enabling telemetry

Either set the plugin option:

```json
{
  "plugin": [
    ["@castai/opencode-kimchi", { "telemetry": true }]
  ]
}
```

Or set the environment variable:

```bash
export OPENCODE_ENABLE_TELEMETRY=1
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENCODE_ENABLE_TELEMETRY` | No | Set to `1` to enable telemetry (alternative to plugin option) |
| `OPENCODE_OTLP_ENDPOINT` | Yes* | Kimchi logs ingest endpoint URL |
| `OPENCODE_OTLP_METRICS_ENDPOINT` | Yes* | Kimchi metrics ingest endpoint URL |
| `OPENCODE_OTLP_HEADERS` | Yes* | Authorization header (`Authorization=Bearer <token>`) |

\* Required when telemetry is enabled.

```bash
export OPENCODE_OTLP_ENDPOINT=https://api.cast.ai/ai-optimizer/v1beta/logs:ingest
export OPENCODE_OTLP_METRICS_ENDPOINT=https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest
export OPENCODE_OTLP_HEADERS="Authorization=Bearer YOUR_API_KEY_HERE"
```

### Data sent

**API Request Logs** — sent per completed assistant message:
- Model, provider, input/output tokens, cache tokens, cost, duration

**Productivity Metrics** — cumulative, flushed every 30 seconds:
- Token usage and cost by model
- Git commits and pull requests (detected from bash tool)
- Lines of code added/removed (from edit/write/patch tools)
- Edit decisions by tool name and language

## Requirements

- [OpenCode](https://opencode.ai) with `@opencode-ai/plugin` SDK ≥1.3.0
- [Kimchi](https://github.com/castai/kimchi) configured with your Cast AI API key

## Development

```bash
npm install
npm run build
npm run dev    # watch mode
npm test       # run tests
```

## License

MIT
