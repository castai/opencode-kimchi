# opencode-kimchi

Automatic model routing for [OpenCode](https://opencode.ai) using [Cast AI's Kimchi](https://github.com/castai/kimchi) models.

The plugin analyzes each message and routes it to the most cost-effective model:

| Tier | Model | When |
|------|-------|------|
| **Reasoning** | glm-5-fp8 | Planning, architecture, debugging, code review, security audit |
| **Coding** | kimi-k2.5 | Implementation, refactoring, writing tests |
| **Quick** | minimax-m2.5 | Simple questions, lookups, summaries, codebase exploration |

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

## Override commands

| Command | Effect |
|---------|--------|
| `/plan` | Use reasoning model for the next message |
| `/code` | Use coding model for the next message |
| `/quick` | Use quick model for the next message |
| `/debug` | Use reasoning model (debugger) for the next message |
| `/review` | Use reasoning model (reviewer) for the next message |
| `/refactor` | Use coding model (refactorer) for the next message |
| `/lock <mode>` | Lock to a model until `/auto` |
| `/auto` | Resume automatic model selection |
| `/kimchi` | Show current mode, session cost, and estimated savings |

## Cost tracking

The plugin tracks token usage and cost per session. Use `/kimchi` to see:

```
Mode: coder
Session cost: $0.0043 (42 messages)
Estimated savings: $0.0127 (74% cheaper than all-reasoning)
Routing: 6 reasoning, 28 coding, 8 quick
```

## Configuration

```json
{
  "plugin": [
    ["@castai/opencode-kimchi", {
      "provider": "kimchi",
      "verbose": true,
      "models": {
        "reasoning": "glm-5-fp8",
        "coding": "kimi-k2.5",
        "quick": "minimax-m2.5"
      },
      "telemetry": true
    }]
  ]
}
```

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
