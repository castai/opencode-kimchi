# opencode-kimchi

Automatic model routing for [OpenCode](https://opencode.ai) using [Cast AI's Kimchi](https://github.com/castai/kimchi) models.

The plugin analyzes each message and routes it to the best model for the task:

| Role | Model | When |
|------|-------|------|
| **Reasoning** | kimi-k2.5 | Planning, architecture, research, complex analysis, trade-off evaluation |
| **Coding** | glm-5-fp8 | Implementation, debugging, refactoring, writing tests |
| **Quick** | minimax-m2.5 | Simple questions, lookups, summaries, short explanations |

## Install

```bash
opencode plugin @castai/opencode-kimchi
```

Or add manually to `opencode.json`:

```json
{
  "plugin": ["@castai/opencode-kimchi"]
}
```

## How it works

The plugin hooks into OpenCode's message pipeline and classifies each user message by analyzing:

- **Keyword signals** — planning/research terms trigger reasoning, implementation/debug terms trigger coding, lookup/explain terms trigger quick
- **Structural cues** — long messages boost reasoning, short messages boost quick, code blocks boost coding
- **Confidence scoring** — when classification is ambiguous, defaults to the coding model (safest middle ground)

Classification happens entirely client-side with zero latency — no extra API calls.

## Override commands

When you know what you need, override the auto-detection:

| Command | Effect |
|---------|--------|
| `/plan` | Use reasoning model for the next message |
| `/code` | Use coding model for the next message |
| `/quick` | Use quick model for the next message |
| `/lock plan` | Lock to reasoning model until `/auto` |
| `/lock code` | Lock to coding model until `/auto` |
| `/lock quick` | Lock to quick model until `/auto` |
| `/auto` | Resume automatic model selection |

One-shot overrides (`/plan`, `/code`, `/quick`) apply to that message only — the next message goes back to auto-detection. Use `/lock` to stay on a specific model.

## Configuration

Pass options via `opencode.json`:

```json
{
  "plugin": [
    ["@castai/opencode-kimchi", {
      "provider": "kimchi",
      "verbose": true
    }]
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | `"kimchi"` | Provider ID to route (matches your Kimchi provider config) |
| `verbose` | `false` | Log model selection decisions to the chat |

## Requirements

- [OpenCode](https://opencode.ai) with the `@opencode-ai/plugin` SDK
- [Kimchi](https://github.com/castai/kimchi) configured with your Cast AI API key

## Development

```bash
npm install
npm run build
npm run dev    # watch mode
```

## License

MIT
