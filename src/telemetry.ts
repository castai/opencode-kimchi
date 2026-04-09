/**
 * OTLP telemetry — sends api_request logs and productivity metrics to Kimchi.
 *
 * Two data flows:
 *   Logs    (api_request)  → logs:ingest endpoint per assistant message
 *   Metrics (token usage, cost, commits, PRs, LOC, edit decisions)
 *           → metrics:ingest endpoint, flushed every 30 s
 *
 * Enabled via plugin option { telemetry: true } or OPENCODE_ENABLE_TELEMETRY env var.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelemetryClient {
  tui: {
    showToast: (opts: {
      body: { message: string; variant: "info" | "success" | "warning" | "error" };
    }) => Promise<boolean>;
  };
}

export interface TelemetryConfig {
  enabled: boolean;
  logsEndpoint: string;
  metricsEndpoint: string;
  headers: Record<string, string>;
}

type SendResult =
  | { error: false }
  | { error: true; status?: number; body?: string; message?: string }
  | null;

interface MetricDataPoint {
  value: number;
  attributes: Record<string, string>;
}

interface MetricPayload {
  name: string;
  description?: string;
  unit?: string;
  dataPoints: MetricDataPoint[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function buildTelemetryConfig(pluginOptionEnabled?: boolean): TelemetryConfig {
  const envEnabled = !!process.env.OPENCODE_ENABLE_TELEMETRY;
  const enabled = envEnabled || (pluginOptionEnabled === true);

  const logsEndpoint = process.env.OPENCODE_OTLP_ENDPOINT || "";
  const metricsEndpoint = process.env.OPENCODE_OTLP_METRICS_ENDPOINT || "";
  const headersStr = process.env.OPENCODE_OTLP_HEADERS || "";

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (headersStr) {
    const match = headersStr.match(/Authorization=Bearer\s+(.+)/);
    if (match) {
      headers["Authorization"] = `Bearer ${match[1].replace(/"/g, "")}`;
    }
  }

  return { enabled, logsEndpoint, metricsEndpoint, headers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowNano(): string {
  return String(Date.now() * 1_000_000);
}

function strAttr(
  key: string,
  value: string,
): { key: string; value: { stringValue: string } } {
  return { key, value: { stringValue: value } };
}

function inferLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript",
    js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
    py: "Python",
    go: "Go",
    rs: "Rust",
    rb: "Ruby",
    java: "Java",
    kt: "Kotlin",
    swift: "Swift",
    c: "C", h: "C",
    cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++",
    cs: "C#",
    php: "PHP",
    dart: "Dart",
    md: "Markdown", mdx: "Markdown",
    json: "JSON",
    yaml: "YAML", yml: "YAML",
    toml: "TOML", ini: "TOML",
    xml: "HTML/XML", html: "HTML/XML", htm: "HTML/XML", svg: "HTML/XML",
    css: "CSS", scss: "CSS", less: "CSS",
    sql: "SQL",
    sh: "Bash", bash: "Bash", zsh: "Bash",
    txt: "Plain text",
    proto: "Protocol Buffers",
    tf: "HCL",
    dockerfile: "Dockerfile",
  };
  return map[ext] || "unknown";
}

function countLineChanges(
  oldStr: string,
  newStr: string,
): { added: number; removed: number } {
  const oldLines = oldStr ? oldStr.split("\n").length : 0;
  const newLines = newStr ? newStr.split("\n").length : 0;
  if (newLines >= oldLines) {
    return { added: newLines - oldLines || 1, removed: 0 };
  }
  return { added: 0, removed: oldLines - newLines || 1 };
}

// ---------------------------------------------------------------------------
// OTLP Log Sender
// ---------------------------------------------------------------------------

async function sendLog(
  config: TelemetryConfig,
  eventName: string,
  attrs: Record<string, string | number> = {},
): Promise<SendResult> {
  if (!config.enabled || !config.logsEndpoint) return null;

  const now = nowNano();

  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [strAttr("service.name", "opencode")],
          droppedAttributesCount: 0,
        },
        scopeLogs: [
          {
            scope: { name: "opencode", version: "1.0.0" },
            logRecords: [
              {
                timeUnixNano: now,
                observedTimeUnixNano: now,
                severityNumber: 9,
                severityText: "INFO",
                eventName: eventName,
                body: { stringValue: eventName },
                attributes: Object.entries(attrs).map(([k, v]) =>
                  strAttr(k, String(v)),
                ),
                droppedAttributesCount: 0,
                flags: 0,
                traceId: "",
                spanId: "",
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(config.logsEndpoint, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      return { error: true, status: response.status, body };
    }
    return { error: false };
  } catch (err) {
    return { error: true, message: String(err) };
  }
}

// ---------------------------------------------------------------------------
// OTLP Metrics Sender
// ---------------------------------------------------------------------------

async function sendMetrics(
  config: TelemetryConfig,
  metrics: MetricPayload[],
  sessionStartNano: string,
): Promise<SendResult> {
  if (!config.enabled || !config.metricsEndpoint) return null;

  const now = nowNano();

  const otlpMetrics = metrics.map((m) => ({
    name: m.name,
    description: m.description || "",
    unit: m.unit || "",
    sum: {
      aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
      isMonotonic: true,
      dataPoints: m.dataPoints.map((dp) => ({
        timeUnixNano: now,
        startTimeUnixNano: sessionStartNano,
        asInt: Number.isInteger(dp.value) ? String(dp.value) : undefined,
        asDouble: Number.isInteger(dp.value) ? undefined : dp.value,
        attributes: Object.entries(dp.attributes).map(([k, v]) =>
          strAttr(k, v),
        ),
      })),
    },
  }));

  const payload = {
    resourceMetrics: [
      {
        resource: {
          attributes: [strAttr("service.name", "opencode")],
        },
        scopeMetrics: [
          {
            scope: { name: "opencode", version: "1.0.0" },
            metrics: otlpMetrics,
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(config.metricsEndpoint, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      return { error: true, status: response.status, body };
    }
    return { error: false };
  } catch (err) {
    return { error: true, message: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Toast helper
// ---------------------------------------------------------------------------

async function showError(
  client: TelemetryClient | null,
  result: SendResult,
): Promise<void> {
  if (!result || !result.error || !client) return;
  let errorMsg =
    ("body" in result ? result.body : undefined) ||
    ("message" in result ? result.message : undefined) ||
    "Unknown error";
  try {
    const parsed = JSON.parse(errorMsg);
    if (parsed.message) errorMsg = parsed.message;
  } catch {
    /* not JSON */
  }
  await client.tui.showToast({
    body: { message: `OTEL: ${errorMsg}`, variant: "error" },
  });
}

// ---------------------------------------------------------------------------
// Telemetry instance — encapsulates mutable state for one plugin lifecycle
// ---------------------------------------------------------------------------

export interface Telemetry {
  /** Handle OpenCode events (session.created, session.idle, message.updated, file.edited) */
  handleEvent: (event: {
    type: string;
    properties?: Record<string, unknown>;
  }) => Promise<void>;

  /** Handle tool execution completions (bash, edit, write, patch) */
  handleToolAfter: (
    input: { tool: string; args: Record<string, unknown> },
    output: { result?: unknown },
  ) => Promise<void>;
}

/**
 * Create a telemetry instance. Returns no-op handlers if telemetry is disabled.
 */
export function createTelemetry(
  config: TelemetryConfig,
  client: TelemetryClient | null,
): Telemetry {
  if (!config.enabled) {
    return {
      handleEvent: async () => {},
      handleToolAfter: async () => {},
    };
  }

  const sentMessages = new Set<string>();
  let currentSessionID = "";
  let cumulativeCommits = 0;
  let cumulativePRs = 0;
  let cumulativeLinesAdded = 0;
  let cumulativeLinesRemoved = 0;
  let cumulativeEditDecisions: Record<string, number> = {};
  let cumulativeTokensByModel: Record<
    string,
    { input: number; output: number; cache_read: number; cache_write: number }
  > = {};
  let cumulativeCostByModel: Record<string, number> = {};
  let sessionStartNano = nowNano();

  const FLUSH_INTERVAL_MS = 30_000;
  let flushInterval: ReturnType<typeof setInterval> | null = null;

  function startMetricFlush(): void {
    if (flushInterval) return;
    flushInterval = setInterval(async () => {
      await flushMetricsNow();
    }, FLUSH_INTERVAL_MS);
  }

  async function flushMetricsNow(): Promise<void> {
    const metrics = buildCurrentMetrics();
    if (metrics.length === 0) return;
    const result = await sendMetrics(config, metrics, sessionStartNano);
    await showError(client, result);
  }

  function buildCurrentMetrics(): MetricPayload[] {
    const metrics: MetricPayload[] = [];
    const sessionAttrs: Record<string, string> = { client: "opencode" };
    if (currentSessionID) {
      sessionAttrs["session.id"] = currentSessionID;
    }

    if (cumulativeCommits > 0) {
      metrics.push({
        name: "claude_code.commit.count",
        unit: "count",
        dataPoints: [{ value: cumulativeCommits, attributes: { ...sessionAttrs } }],
      });
    }

    if (cumulativePRs > 0) {
      metrics.push({
        name: "claude_code.pull_request.count",
        unit: "count",
        dataPoints: [{ value: cumulativePRs, attributes: { ...sessionAttrs } }],
      });
    }

    if (cumulativeLinesAdded > 0) {
      metrics.push({
        name: "claude_code.lines_of_code.count",
        unit: "count",
        dataPoints: [
          { value: cumulativeLinesAdded, attributes: { ...sessionAttrs, type: "added" } },
        ],
      });
    }

    if (cumulativeLinesRemoved > 0) {
      metrics.push({
        name: "claude_code.lines_of_code.count",
        unit: "count",
        dataPoints: [
          {
            value: cumulativeLinesRemoved,
            attributes: { ...sessionAttrs, type: "removed" },
          },
        ],
      });
    }

    for (const [key, count] of Object.entries(cumulativeEditDecisions)) {
      if (count <= 0) continue;
      const [toolName, language] = key.split("|");
      metrics.push({
        name: "claude_code.code_edit_tool.decision",
        unit: "count",
        dataPoints: [
          {
            value: count,
            attributes: {
              ...sessionAttrs,
              tool_name: toolName,
              language: language || "unknown",
              decision: "accept",
              source: "auto",
            },
          },
        ],
      });
    }

    for (const [model, tokens] of Object.entries(cumulativeTokensByModel)) {
      const tokenTypes: Array<{ type: string; value: number }> = [
        { type: "input", value: tokens.input },
        { type: "output", value: tokens.output },
        { type: "cacheRead", value: tokens.cache_read },
        { type: "cacheCreation", value: tokens.cache_write },
      ];
      for (const t of tokenTypes) {
        if (t.value > 0) {
          metrics.push({
            name: "claude_code.token.usage",
            unit: "count",
            dataPoints: [
              { value: t.value, attributes: { ...sessionAttrs, type: t.type, model } },
            ],
          });
        }
      }
    }

    for (const [model, cost] of Object.entries(cumulativeCostByModel)) {
      if (cost > 0) {
        metrics.push({
          name: "claude_code.cost.usage",
          unit: "USD",
          dataPoints: [{ value: cost, attributes: { ...sessionAttrs, model } }],
        });
      }
    }

    return metrics;
  }

  async function handleEvent(event: {
    type: string;
    properties?: Record<string, unknown>;
  }): Promise<void> {
    if (event.type === "session.created") {
      const id =
        (event.properties?.sessionID as string) ||
        ((event.properties?.info as Record<string, unknown>)?.id as string);
      if (id) {
        currentSessionID = id;
        sessionStartNano = nowNano();
        cumulativeCommits = 0;
        cumulativePRs = 0;
        cumulativeLinesAdded = 0;
        cumulativeLinesRemoved = 0;
        cumulativeEditDecisions = {};
        cumulativeTokensByModel = {};
        cumulativeCostByModel = {};
      }
      return;
    }

    // Flush on idle so metrics aren't lost if the user quits
    if (event.type === "session.idle") {
      await flushMetricsNow();
      return;
    }

    if (event.type === "message.updated") {
      const info =
        (event.properties?.info as Record<string, unknown>) || {};

      // Fallback: session.created may not fire in all environments
      if (!currentSessionID) {
        const sid =
          (event.properties?.sessionID as string) ||
          String(info.sessionID || "");
        if (sid) {
          currentSessionID = sid;
          sessionStartNano = nowNano();
        }
      }

      const time = (info.time as Record<string, number>) || {};
      if (info.role === "assistant" && info.finish && time.completed) {
        const messageId = String(info.id || "unknown");
        if (sentMessages.has(messageId)) return;

        sentMessages.add(messageId);
        const tokens = (info.tokens as Record<string, unknown>) || {};
        const cache = (tokens.cache as Record<string, number>) || {};
        const provider = String(info.providerID || "unknown");
        const model = String(info.modelID || "unknown");
        const inputTokens = Number(tokens.input) || 0;
        const outputTokens = Number(tokens.output) || 0;
        const cacheReadTokens = Number(cache.read) || 0;
        const cacheCreationTokens = Number(cache.write) || 0;
        const cost = Number(info.cost) || 0;
        const durationMs = time.completed - time.created;

        const result = await sendLog(config, "api_request", {
          "event.name": "api_request",
          client: "opencode",
          model,
          provider,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheReadTokens,
          cache_creation_tokens: cacheCreationTokens,
          cost_usd: cost,
          duration_ms: durationMs,
        });
        await showError(client, result);

        if (!cumulativeTokensByModel[model]) {
          cumulativeTokensByModel[model] = {
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
          };
        }
        cumulativeTokensByModel[model].input += inputTokens;
        cumulativeTokensByModel[model].output += outputTokens;
        cumulativeTokensByModel[model].cache_read += cacheReadTokens;
        cumulativeTokensByModel[model].cache_write += cacheCreationTokens;

        if (cost > 0) {
          cumulativeCostByModel[model] =
            (cumulativeCostByModel[model] || 0) + cost;
        }

        startMetricFlush();
      }
    }

    if (event.type === "file.edited") {
      const filePath = String(
        event.properties?.filePath || event.properties?.path || "",
      );
      const language = filePath ? inferLanguage(filePath) : "unknown";

      const diff = event.properties?.diff as
        | Record<string, unknown>
        | undefined;
      if (diff) {
        const added = Number(diff.added || diff.linesAdded || 0);
        const removed = Number(diff.removed || diff.linesRemoved || 0);
        if (added > 0) cumulativeLinesAdded += added;
        if (removed > 0) cumulativeLinesRemoved += removed;
      } else {
        cumulativeLinesAdded += 1;
      }

      const toolName = "Edit";
      const key = `${toolName}|${language}`;
      cumulativeEditDecisions[key] = (cumulativeEditDecisions[key] || 0) + 1;

      startMetricFlush();
    }
  }

  async function handleToolAfter(
    input: { tool: string; args: Record<string, unknown> },
    _output: { result?: unknown },
  ): Promise<void> {
    const toolName = input.tool;

    if (toolName === "bash") {
      const command = String(input.args?.command || "");

      if (/git\s+commit\b/.test(command) && !/--dry-run/.test(command)) {
        cumulativeCommits += 1;
        startMetricFlush();
      }

      if (/gh\s+pr\s+create\b/.test(command)) {
        cumulativePRs += 1;
        startMetricFlush();
      }
    }

    if (toolName === "edit") {
      const filePath = String(input.args?.filePath || "");
      const language = filePath ? inferLanguage(filePath) : "unknown";
      const oldString = String(input.args?.oldString || "");
      const newString = String(input.args?.newString || "");

      const changes = countLineChanges(oldString, newString);
      cumulativeLinesAdded += changes.added;
      cumulativeLinesRemoved += changes.removed;

      const key = `Edit|${language}`;
      cumulativeEditDecisions[key] = (cumulativeEditDecisions[key] || 0) + 1;

      startMetricFlush();
    }

    if (toolName === "write") {
      const filePath = String(input.args?.filePath || "");
      const language = filePath ? inferLanguage(filePath) : "unknown";
      const content = String(input.args?.content || "");
      const lines = content ? content.split("\n").length : 1;

      cumulativeLinesAdded += lines;

      const key = `Write|${language}`;
      cumulativeEditDecisions[key] = (cumulativeEditDecisions[key] || 0) + 1;

      startMetricFlush();
    }

    if (toolName === "patch") {
      const filePath = String(input.args?.filePath || "");
      const language = filePath ? inferLanguage(filePath) : "unknown";
      const patch = String(input.args?.patch || input.args?.diff || "");

      let added = 0;
      let removed = 0;
      for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }
      cumulativeLinesAdded += added || 1;
      cumulativeLinesRemoved += removed;

      const key = `Patch|${language}`;
      cumulativeEditDecisions[key] = (cumulativeEditDecisions[key] || 0) + 1;

      startMetricFlush();
    }
  }

  return { handleEvent, handleToolAfter };
}
