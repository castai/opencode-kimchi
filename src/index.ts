import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import type { ProfileID } from "./profiles.js";
import type { ModelTier } from "./model-registry.js";
import { ModelRegistry } from "./model-registry.js";
import { resolveProfiles, type AgentProfile } from "./profiles.js";
import { classifyWithHeuristics } from "./heuristic-classifier.js";
import { extractSignals, detectPhase } from "./phase-detector.js";
import {
  getSession,
  setOverride,
  consumeOneShotOverride,
  consumeNextTierSuggestion,
  updateSignals,
  recordDecision,
  setActiveProfile,
  setActiveAgent,
  incrementLiveSignal,
} from "./session-state.js";
import {
  getAgentRouting,
  shouldSkipClassification,
  getTaskToolEnhancement,
} from "./agent-router.js";
import {
  KIMCHI_AGENT_NAME,
  KIMCHI_AGENT_PROMPT,
  KIMCHI_AGENT_DESCRIPTION,
} from "./kimchi-agent.js";
import { routingTools } from "./tools.js";
import { buildTelemetryConfig, createTelemetry } from "./telemetry.js";
import {
  recordMessageCost,
  getSessionCost,
  estimateSavings,
  formatSessionCost,
} from "./cost-tracker.js";
import { classifyWithLlm } from "./llm-classifier.js";

const KIMCHI_PROVIDER = "kimchi";
const CASTAI_LLM_BASE = "https://llm.cast.ai/openai/v1";

const EDIT_TOOLS = new Set(["write", "edit", "patch", "bash", "shell", "file_write", "file_edit"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "search", "find", "file_read"]);
const ERROR_PATTERN = /error|exception|failed|traceback/i;

const TIER_TO_PROFILE: Record<ModelTier, ProfileID> = {
  reasoning: "planner",
  coding: "coder",
  quick: "assistant",
};

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is { type: "text"; text: string } =>
      p != null && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function getProviderID(input: Record<string, any>): string | undefined {
  if (input.model?.providerID) return input.model.providerID;
  if (input.provider?.info?.id) return input.provider.info.id;
  return undefined;
}

function getModelID(input: Record<string, any>): string | undefined {
  return input.model?.id ?? input.model?.modelID;
}

function getSessionID(input: Record<string, any>): string | undefined {
  return input.sessionID ?? undefined;
}

function parseCommand(text: string): { profile: ProfileID; sticky: boolean } | "auto" | "kimchi" | null {
  const trimmed = text.trimStart();

  if (/^\/auto\b/i.test(trimmed)) return "auto";
  if (/^\/kimchi\b/i.test(trimmed)) return "kimchi";

  if (/^\/plan\b/i.test(trimmed)) return { profile: "planner", sticky: false };
  if (/^\/code\b/i.test(trimmed)) return { profile: "coder", sticky: false };
  if (/^\/quick\b/i.test(trimmed)) return { profile: "assistant", sticky: false };
  if (/^\/debug\b/i.test(trimmed)) return { profile: "debugger", sticky: false };
  if (/^\/review\b/i.test(trimmed)) return { profile: "reviewer", sticky: false };
  if (/^\/refactor\b/i.test(trimmed)) return { profile: "refactorer", sticky: false };

  const lockMatch = trimmed.match(
    /^\/lock\s+(plan|code|quick|debug|review|refactor|planner|coder|assistant|debugger|reviewer|refactorer|reasoning|coding)\b/i,
  );
  if (lockMatch) {
    const arg = lockMatch[1].toLowerCase();
    const roleMap: Record<string, ProfileID> = {
      plan: "planner",
      planner: "planner",
      reasoning: "planner",
      code: "coder",
      coder: "coder",
      coding: "coder",
      quick: "assistant",
      assistant: "assistant",
      debug: "debugger",
      debugger: "debugger",
      review: "reviewer",
      reviewer: "reviewer",
      refactor: "refactorer",
      refactorer: "refactorer",
    };
    return { profile: roleMap[arg]!, sticky: true };
  }

  return null;
}

function log(verbose: boolean, message: string): void {
  if (verbose) {
    console.log(`[kimchi] ${message}`);
  }
}

const PROFILE_LABELS: Record<string, string> = {
  planner: "Planning mode",
  coder: "Coding mode",
  assistant: "Quick mode",
  debugger: "Debug mode",
  reviewer: "Review mode",
  refactorer: "Refactor mode",
};

const TIER_LABELS: Record<string, string> = {
  reasoning: "Reasoning",
  coding: "Coding",
  quick: "Quick",
};

function humanizeSource(source: string): string {
  if (source.startsWith("heuristic:")) return "auto-detected";
  if (source.startsWith("llm-classifier:")) return "auto-classified";
  if (source.startsWith("phase:")) return "conversation phase";
  if (source.startsWith("agent:")) return source.replace("agent: ", "").replace(" → ", " agent → ");
  if (source.startsWith("override:")) return "slash command";
  if (source.startsWith("locked:")) return "locked";
  if (source.startsWith("sticky:")) return "continuing";
  if (source.startsWith("llm-suggestion:")) return "model suggested";
  if (source.startsWith("direct:")) return "manual selection";
  return "auto";
}

function showRouting(client: any, profile: string, model: string, tier: string, source: string): void {
  const label = PROFILE_LABELS[profile] ?? profile;
  const tierLabel = TIER_LABELS[tier] ?? tier;
  const reason = humanizeSource(source);

  client?.tui?.showToast({
    body: {
      title: `Kimchi: ${label}`,
      message: `${model} (${tierLabel} tier · ${reason})`,
      variant: "info" as const,
      duration: 5000,
    },
  }).catch(() => {});
}

const plugin: Plugin = async (ctx, options) => {
  const providerID = (options?.provider as string) ?? KIMCHI_PROVIDER;
  const verbose = (options?.verbose as boolean) ?? false;
  const client = ctx.client;

  const registry = new ModelRegistry();

  if (options?.models) {
    registry.applyOverrides(options.models as Partial<Record<ModelTier, string>>);
  }

  let profiles = resolveProfiles(registry);

  const llmBaseUrl = (options?.llmBaseUrl as string) ?? CASTAI_LLM_BASE;
  const llmClassifierEnabled = (options?.llmClassifier as boolean) ?? true;
  const llmClassifierThreshold = (options?.llmClassifierThreshold as number) ?? 0.5;
  let apiKey = (options?.apiKey as string) ?? process.env.CASTAI_API_KEY;

  const telemetryConfig = buildTelemetryConfig(options?.telemetry as boolean | undefined);
  const telemetry = createTelemetry(telemetryConfig, ctx.client as any);

  return {
    tool: routingTools,

    provider: {
      id: providerID,
      models: async (provider) => {
        const result: Record<string, any> = {};

        const existingModels = provider?.models ?? {};
        const firstExisting = Object.values(existingModels)[0] as any;
        const api = firstExisting?.api;

        const defaultModel = registry.getForTier("coding");
        if (defaultModel && api) {
          result["auto"] = {
            api,
            name: "Kimchi Auto (routed)",
            capabilities: {
              temperature: true,
              reasoning: false,
              attachment: false,
              toolcall: true,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            cost: {
              input: defaultModel.cost.input,
              output: defaultModel.cost.output,
              cache: { read: 0, write: 0 },
            },
            limit: {
              context: defaultModel.contextWindow,
              output: defaultModel.maxOutput,
            },
            status: "active" as const,
            options: {},
            headers: {},
            release_date: "2025-01-01",
          };
        }

        const tiers: ModelTier[] = ["reasoning", "coding", "quick"];
        for (const tier of tiers) {
          const model = registry.getForTier(tier);
          if (!model) continue;

          result[tier] = {
            api,
            name: `Kimchi ${tier.charAt(0).toUpperCase() + tier.slice(1)} (${model.id})`,
            capabilities: {
              temperature: true,
              reasoning: model.supportsReasoning,
              attachment: false,
              toolcall: true,
              input: { text: true, audio: false, image: model.supportsImages, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: model.supportsReasoning ? { field: "reasoning_content" as const } : false,
            },
            cost: {
              input: model.cost.input,
              output: model.cost.output,
              cache: { read: 0, write: 0 },
            },
            limit: {
              context: model.contextWindow,
              output: model.maxOutput,
            },
            status: "active" as const,
            options: {},
            headers: {},
            release_date: "2025-01-01",
          };
        }

        for (const model of registry.all()) {
          if (!result[model.id]) {
            result[model.id] = {
              api,
              name: model.name,
              capabilities: {
                temperature: true,
                reasoning: model.supportsReasoning,
                attachment: false,
                toolcall: true,
                input: { text: true, audio: false, image: model.supportsImages, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: model.supportsReasoning ? { field: "reasoning_content" as const } : false,
              },
              cost: {
                input: model.cost.input,
                output: model.cost.output,
                cache: { read: 0, write: 0 },
              },
              limit: {
                context: model.contextWindow,
                output: model.maxOutput,
              },
              status: "active" as const,
              options: {},
              headers: {},
              release_date: "2025-01-01",
            };
          }
        }

        return result;
      },
    },

    config: async (config: any) => {
      const providerConfig = config?.provider?.[providerID];
      if (providerConfig?.models && typeof providerConfig.models === "object") {
        registry.loadFromConfig(providerID, providerConfig.models);
        profiles = resolveProfiles(registry);
        log(verbose, `loaded ${registry.all().length} models from config`);
      }

      if (providerConfig?.options?.apiKey) {
        apiKey = providerConfig.options.apiKey;
      }

      const autoModel = `${providerID}/auto`;

      if (!config.agent) config.agent = {};

      if (!config.agent[KIMCHI_AGENT_NAME]) {
        config.agent[KIMCHI_AGENT_NAME] = {
          model: autoModel,
          mode: "primary",
          prompt: KIMCHI_AGENT_PROMPT,
          description: KIMCHI_AGENT_DESCRIPTION,
          color: "accent",
        };
      }

      if (!config.default_agent) {
        config.default_agent = KIMCHI_AGENT_NAME;
      }

      if (!config.model) {
        config.model = autoModel;
      }

      const subagentDefaults: Record<string, { model: string; mode?: string }> = {
        explore:     { model: autoModel, mode: "subagent" },
        general:     { model: autoModel, mode: "subagent" },
        title:       { model: `${providerID}/quick`, mode: "subagent" },
        summary:     { model: `${providerID}/quick`, mode: "subagent" },
        compaction:  { model: `${providerID}/quick`, mode: "subagent" },
      };
      for (const [agent, defaults] of Object.entries(subagentDefaults)) {
        if (!config.agent[agent]?.model) {
          config.agent[agent] = { ...config.agent[agent], ...defaults };
        }
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        if (!output?.messages?.length) return;

        const sessionID = (output.messages[0]?.info as any)?.sessionID;
        if (!sessionID) return;

        const signals = extractSignals(
          output.messages.map((m) => ({
            info: { role: ((m.info as any)?.role as string) ?? "unknown" },
            parts: Array.isArray(m.parts)
              ? m.parts.map((p: any) => ({
                  type: p?.type ?? "unknown",
                  tool: p?.tool as string | undefined,
                  text: p?.text as string | undefined,
                }))
              : [],
          })),
        );

        updateSignals(sessionID, signals);
      } catch (err) {
        log(verbose, `messages.transform error: ${err}`);
      }
    },

    "chat.message": async (input, output) => {
      try {
        const inputProviderID = getProviderID(input as any);
        if (inputProviderID && inputProviderID !== providerID) {
          return;
        }

        const text = extractText(output?.parts);
        const sessionID = getSessionID(input as any);
        if (!sessionID) return;

        const command = parseCommand(text);
        if (command === "auto") {
          setOverride(sessionID, null);
          log(verbose, "Auto mode selection resumed.");
        } else if (command === "kimchi") {
          const session = getSession(sessionID);
          const sessionCost = getSessionCost(sessionID);
          const expensive = registry.getMostExpensiveModel();
          const savings = expensive
            ? estimateSavings(sessionCost, expensive.cost.input, expensive.cost.output)
            : 0;
          const costReport = formatSessionCost(sessionCost, savings);
          const activeInfo = session.activeProfile ?? "auto";
          log(true, `Mode: ${activeInfo}\n${costReport}`);
        } else if (command) {
          setOverride(sessionID, command);
        }

        const agentName = (input as any).agent as string | undefined;
        if (agentName) {
          setActiveAgent(sessionID, agentName);
        }

        const agentRouting = agentName ? getAgentRouting(agentName) : undefined;
        if (agentRouting && shouldSkipClassification(agentName!)) {
          const tier = agentRouting.tier;
          const model = registry.getForTier(tier);
          const profileId = TIER_TO_PROFILE[tier];
          setActiveProfile(sessionID, profileId);
          recordDecision(sessionID, { profile: profileId, source: `agent: ${agentName} → ${tier}` });
          log(verbose, `-> ${profileId} (agent: ${agentName})`);
          showRouting(client, profileId, model?.id ?? tier, tier, `agent: ${agentName}`);
          return;
        }

        const inputModelID = getModelID(input as any);
        const isTierSelect = inputModelID === "reasoning" || inputModelID === "coding" || inputModelID === "quick";

        if (isTierSelect) {
          const tier = inputModelID as ModelTier;
          const model = registry.getForTier(tier);
          const profileId = TIER_TO_PROFILE[tier];
          setActiveProfile(sessionID, profileId);
          recordDecision(sessionID, { profile: profileId, source: `direct: ${tier}` });
          log(verbose, `-> ${profileId} (direct ${tier} selection)`);
          showRouting(client, profileId, model?.id ?? tier, tier, `direct: ${tier}`);
          return;
        }

        const isAutoRouted = !inputModelID || inputModelID === "auto";

        if (!isAutoRouted) {
          const knownModel = registry.get(inputModelID!);
          if (knownModel) {
            const profileId = TIER_TO_PROFILE[knownModel.tier];
            setActiveProfile(sessionID, profileId);
            recordDecision(sessionID, { profile: profileId, source: `direct: ${inputModelID}` });
          }
          return;
        }

        const STICKY_THRESHOLD = 0.55;

        let profile: AgentProfile;
        let source: string;

        const override = consumeOneShotOverride(sessionID);
        if (override) {
          profile = profiles[override.profile];
          source = override.sticky ? `locked: ${override.profile}` : `override: ${override.profile}`;
        } else {
          const tierSuggestion = consumeNextTierSuggestion(sessionID);
          if (tierSuggestion) {
            const suggestedProfile = TIER_TO_PROFILE[tierSuggestion];
            profile = profiles[suggestedProfile];
            source = `llm-suggestion: ${tierSuggestion}`;
          } else {
            const session = getSession(sessionID);

            const mergedSignals = session.signals ? { ...session.signals } : null;
            if (mergedSignals && session.liveSignals) {
              mergedSignals.recentEditToolCalls = Math.max(
                mergedSignals.recentEditToolCalls,
                session.liveSignals.edits,
              );
              mergedSignals.recentReadToolCalls = Math.max(
                mergedSignals.recentReadToolCalls,
                session.liveSignals.reads,
              );
              mergedSignals.errorMentions = Math.max(
                mergedSignals.errorMentions,
                session.liveSignals.errors,
              );
            }

            let detected: { profile: ProfileID; confidence: number; source: string };

            if (mergedSignals && mergedSignals.totalMessages >= 3) {
              const result = detectPhase(mergedSignals, text);
              detected = { profile: result.profile, confidence: result.confidence, source: result.reason };
            } else {
              const result = classifyWithHeuristics(text);
              detected = { profile: result.profile, confidence: result.confidence, source: result.reason };
            }

            // Cascade: if heuristics are ambiguous, ask the LLM to classify
            const currentClassifierModel = registry.getForTier("quick");
            if (detected.confidence < llmClassifierThreshold && llmClassifierEnabled && apiKey && currentClassifierModel) {
              const llmTier = await classifyWithLlm(text, {
                baseUrl: llmBaseUrl,
                apiKey,
                model: currentClassifierModel.id,
              });
              if (llmTier) {
                const llmProfile = TIER_TO_PROFILE[llmTier];
                detected = { profile: llmProfile, confidence: 0.7, source: `llm-classifier: ${llmTier}` };
                log(verbose, `heuristic ambiguous (${(detected.confidence * 100).toFixed(0)}%), LLM classified as ${llmTier}`);
              }
            }

            const currentProfile = session.activeProfile;
            const currentTier = currentProfile ? profiles[currentProfile]?.tier : null;
            const detectedTier = profiles[detected.profile]?.tier;
            const sameTier = currentTier === detectedTier;

            if (currentProfile && detected.profile !== currentProfile && sameTier && detected.confidence < STICKY_THRESHOLD) {
              profile = profiles[currentProfile];
              source = `sticky: ${currentProfile} (detected ${detected.profile} at ${(detected.confidence * 100).toFixed(0)}%, same tier, below threshold)`;
            } else {
              profile = profiles[detected.profile];
              source = detected.source;
            }
          }
        }

        setActiveProfile(sessionID, profile.id);
        recordDecision(sessionID, { profile: profile.id, source });
        log(verbose, `-> ${profile.label} | ${source}`);
        showRouting(client, profile.id, profile.model, profile.tier, source);
      } catch (err) {
        log(verbose, `chat.message error: ${err}`);
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        const inputProviderID = (input as any)?.model?.providerID;
        if (inputProviderID && inputProviderID !== providerID) return;

        const sessionID = getSessionID(input as any);
        if (sessionID) {
          const session = getSession(sessionID);
          if (session.activeProfile) {
            output.system.push(profiles[session.activeProfile].systemPrompt);
            return;
          }
        }

        const modelID = getModelID(input as any);
        if (modelID) {
          const fallback = Object.values(profiles).find((p) => p.model === modelID);
          if (fallback) {
            output.system.push(fallback.systemPrompt);
          }
        }
      } catch (err) {
        log(verbose, `system.transform error: ${err}`);
      }
    },

    "chat.params": async (input, output) => {
      try {
        const inputProviderID = getProviderID(input as any);
        if (inputProviderID && inputProviderID !== providerID) return;

        const sessionID = getSessionID(input as any);
        if (sessionID) {
          const session = getSession(sessionID);
          if (session.activeProfile) {
            const activeProfile = profiles[session.activeProfile];
            output.temperature = activeProfile.temperature;
            output.options = { ...output.options, model: activeProfile.model };
            return;
          }
        }

        const modelID = getModelID(input as any);
        if (modelID) {
          const fallback = Object.values(profiles).find((p) => p.model === modelID);
          if (fallback) {
            output.temperature = fallback.temperature;
          }
        }
      } catch (err) {
        log(verbose, `chat.params error: ${err}`);
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        const toolName = (input.tool ?? "").toLowerCase();
        if (EDIT_TOOLS.has(toolName)) {
          incrementLiveSignal(input.sessionID, "edits");
        }
        if (READ_TOOLS.has(toolName)) {
          incrementLiveSignal(input.sessionID, "reads");
        }
        if (ERROR_PATTERN.test(output.output ?? "")) {
          incrementLiveSignal(input.sessionID, "errors");
        }
      } catch (err) {
        log(verbose, `tool.execute.after error: ${err}`);
      }
    },

    "experimental.session.compacting": async (input, output) => {
      try {
        const session = getSession(input.sessionID);
        if (session.activeProfile) {
          const modeHistory = session.history
            .slice(-5)
            .map((h) => h.profile)
            .join(" → ");
          output.context.push(
            `[Model routing: mode=${session.activeProfile}, ` +
            `activity: ${session.liveSignals.edits} edits, ${session.liveSignals.reads} reads, ` +
            `${session.liveSignals.errors} errors. History: ${modeHistory}]`,
          );
        }
      } catch (err) {
        log(verbose, `session.compacting error: ${err}`);
      }
    },

    event: async ({ event }) => {
      try {
        if (event.type !== "message.updated") return;
        const props = (event as any).properties;
        if (!props?.info) return;

        const info = props.info;
        if (info.role !== "assistant") return;
        if (info.providerID !== providerID) return;
        if (!info.id || !info.sessionID) return;

        const session = getSession(info.sessionID);
        const activeTier = session.activeProfile
          ? profiles[session.activeProfile]?.tier ?? "coding"
          : "coding";

        recordMessageCost(
          info.sessionID,
          info.id,
          activeTier,
          info.cost ?? 0,
          info.tokens?.input ?? 0,
          info.tokens?.output ?? 0,
          session.activeAgent ?? undefined,
        );
      } catch (err) {
        log(verbose, `event error: ${err}`);
      }
    },

    "tool.definition": async (input, output) => {
      try {
        if (input.toolID === "task") {
          output.description = getTaskToolEnhancement() + "\n\n" + output.description;
        }
      } catch (err) {
        log(verbose, `tool.definition error: ${err}`);
      }
    },

    "command.execute.before": async (input, output) => {
      try {
        if (input.command !== "kimchi") return;

        const session = getSession(input.sessionID);
        const sessionCost = getSessionCost(input.sessionID);
        const expensive = registry.getMostExpensiveModel();
        const savings = expensive
          ? estimateSavings(sessionCost, expensive.cost.input, expensive.cost.output)
          : 0;

        const lines: string[] = [];
        lines.push(`Mode: ${session.activeProfile ?? "auto"}`);
        if (session.activeAgent) {
          lines.push(`Agent: ${session.activeAgent}`);
        }
        if (session.override) {
          lines.push(`Override: ${session.override.profile} (${session.override.sticky ? "locked" : "one-shot"})`);
        }
        lines.push(formatSessionCost(sessionCost, savings));

        output.parts.push({
          type: "text",
          text: lines.join("\n"),
        } as any);
      } catch (err) {
        log(verbose, `command.execute.before error: ${err}`);
      }
    },
  };
};

const pluginModule: PluginModule = {
  id: "opencode-kimchi",
  server: plugin,
};

export default pluginModule;
export { plugin, ModelRegistry };
export { resolveProfiles } from "./profiles.js";
export { classifyWithHeuristics } from "./heuristic-classifier.js";
export { detectPhase, extractSignals } from "./phase-detector.js";
export { routingTools } from "./tools.js";
export { buildTelemetryConfig, createTelemetry } from "./telemetry.js";
export { classifyWithLlm } from "./llm-classifier.js";
export { getAgentRouting, shouldSkipClassification } from "./agent-router.js";
export { KIMCHI_AGENT_NAME } from "./kimchi-agent.js";
export type { ProfileID, AgentProfile } from "./profiles.js";
export type { ModelTier, KimchiModel } from "./model-registry.js";
export type { ConversationPhase, PhaseDetectionResult } from "./phase-detector.js";
export type { TelemetryConfig, TelemetryClient, Telemetry } from "./telemetry.js";
