import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import type { ProfileID } from "./profiles.js";
import type { ModelTier, KimchiModel } from "./model-registry.js";
import { ModelRegistry, isSunset, isDeprecated } from "./model-registry.js";
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
  setSelectedModel,
  getSelectedModel,
  clearSelectedModel,

  incrementLiveSignal,
  updateContextEstimate,
  resetContextEstimate,
  trackFileModified,
  trackFileRead,
  trackToolError,
  trackDirectToolCall,
  trackDelegationToolCall,
  shouldInjectDelegationReminder,
  markReminderInjected,
  getDelegationRatio,
  hasShownDeprecationWarning,
  markDeprecationWarningShown,
} from "./session-state.js";
import {
  getAgentRouting,
  shouldSkipClassification,
  isPrimaryAgent,
  isSystemAgent,
  getTaskToolEnhancement,
  getDelegationGuidance,
} from "./agent-router.js";
import {
  KIMCHI_AGENT_NAME,
  KIMCHI_AGENT_DESCRIPTION,
  buildKimchiAutoPrompt,
  isSelfExecutingModel,
  isWeakToolCallModel,
  hasWeakToolCallModels,
  isComplexTool,
  getComplexToolWarning,
} from "./kimchi-agent.js";
import { routingTools } from "./tools.js";
import { buildTelemetryConfig, createTelemetry, TelemetryPluginOption } from "./telemetry.js";
import {
  recordMessageCost,
} from "./cost-tracker.js";
import { classifyWithLlm } from "./llm-classifier.js";
import {
  buildCompactionContext,
  buildCompactionPrompt,
  shouldTriggerProactiveCompaction,
  triggerProactiveCompaction,
} from "./compaction.js";
import {
  onSessionError,
  hasPendingFallback,
  getNextFallbackModel,
  consumePendingFallback,
  clearFallbackState,
} from "./model-fallback.js";

const KIMCHI_PROVIDER = "kimchi";
const CASTAI_LLM_BASE = "https://llm.cast.ai/openai/v1";

const EDIT_TOOLS = new Set(["write", "edit", "patch", "bash", "shell", "file_write", "file_edit"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "search", "find", "file_read"]);
const DIRECT_WORK_TOOLS = new Set([...EDIT_TOOLS, ...READ_TOOLS]);
const DELEGATION_TOOLS = new Set(["task", "call_omo_agent"]);

/** Populated by tool.definition hook — tracks tools whose schemas were flagged as complex. */
const complexToolIDs = new Set<string>();

const DELEGATION_REMINDER =
  `[DELEGATE] You are calling tools directly. As orchestrator, delegate instead:\n` +
  `task(description="<3-5 words>", subagent_type="explore"|"general", prompt="<what to do>")\n` +
  `Direct tool use is only for <10 line single-file edits.`;
const ERROR_PATTERN = /\b(?:error|exception|failed|traceback)\b(?![\s-]*(?:handling|handler|boundary|boundaries|recovery|message|code|type|class))/i;

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

function extractFilePath(args: any): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const raw = args.filePath ?? args.file ?? args.path ?? args.filename;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return undefined;
}

function parseCommand(text: string): { profile: ProfileID; sticky: boolean } | "auto" | null {
  const trimmed = text.trimStart();

  if (/^\/auto\b/i.test(trimmed)) return "auto";

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

/**
 * Clamp temperature for models that support reasoning/thinking.
 * Anthropic requires temperature=1 when extended thinking is enabled;
 * setting any other value causes a 400 error.
 */
function safeTemperature(desired: number, model: KimchiModel | undefined): number {
  if (model?.supportsReasoning) return 1;
  return desired;
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



const lastToastPerSession = new Map<string, string>();
const MAX_TOAST_SESSIONS = 200;

function showRouting(client: any, profile: string, model: string, tier: string, source: string, sessionID?: string): void {
  const toastKey = `${profile}:${model}`;

  if (sessionID) {
    const last = lastToastPerSession.get(sessionID);
    if (last === toastKey) return;
    if (lastToastPerSession.size >= MAX_TOAST_SESSIONS) {
      const oldest = lastToastPerSession.keys().next().value!;
      lastToastPerSession.delete(oldest);
    }
    lastToastPerSession.set(sessionID, toastKey);
  }

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

function warnIfDeprecated(
  sessionID: string,
  model: KimchiModel | undefined,
  now: Date,
  client: any,
): void {
  if (!model) return;
  if (!model.deprecatedAt && !model.sunsetAt) return;
  if (hasShownDeprecationWarning(sessionID, model.id)) return;

  const sunset = isSunset(model, now);
  const deprecated = isDeprecated(model, now);
  if (!sunset && !deprecated) return;

  const title = sunset ? "Kimchi: Model sunset" : "Kimchi: Model deprecated";
  const parts: string[] = [];

  if (model.replacementModel) {
    parts.push(`Replacement: ${model.replacementModel}`);
  }
  if (model.deprecationNote) {
    parts.push(model.deprecationNote);
  }
  if (parts.length === 0) {
    parts.push(
      sunset
        ? "This model is no longer available for auto-routing."
        : "This model is scheduled for removal."
    );
  }

  client?.tui?.showToast({
    body: {
      title,
      message: parts.join(" · "),
      variant: "warning" as const,
      duration: 7000,
    },
  }).catch(() => {});

  markDeprecationWarningShown(sessionID, model.id);
}

const plugin: Plugin = async (ctx, options) => {
  const providerID = (options?.provider as string) ?? KIMCHI_PROVIDER;
  const verbose = (options?.verbose as boolean) ?? false;
  const client = ctx.client;

  const registry = new ModelRegistry();

  if (options?.models) {
    registry.applyOverrides(options.models as Partial<Record<ModelTier, string>>);
  }

  if (options?.priorities) {
    registry.applyPriorityOverrides(options.priorities as Record<string, Partial<Record<ModelTier, number>>>);
  }

  let profiles = resolveProfiles(registry);

   let llmBaseUrl = (options?.llmBaseUrl as string) ?? CASTAI_LLM_BASE;
   const llmClassifierEnabled = (options?.llmClassifier as boolean) ?? true;
   const llmClassifierThreshold = (options?.llmClassifierThreshold as number) ?? 0.5;
   let apiKey = (options?.apiKey as string) ?? process.env.CASTAI_API_KEY;
   
   // Track the effective baseUrl that may be overridden by provider config
   let effectiveBaseUrl = llmBaseUrl;

  const telemetryConfig = buildTelemetryConfig({ ...(options as TelemetryPluginOption | undefined), apiKey }, verbose);
  const telemetry = createTelemetry(telemetryConfig, ctx.client as any);

  return {
    tool: routingTools,

       provider: {
         id: providerID,
         npm: "@ai-sdk/openai-compatible",
         models: async (provider) => {
          const result: Record<string, any> = {};
          const now = new Date();

          const existingModels = provider?.models ?? {};
          const firstExisting = Object.values(existingModels)[0] as any;
          const baseApi = firstExisting?.api;

          // The apiKey and baseURL come from the provider config, available via baseApi
          // This is because the provider config is loaded before the models hook runs
          const providerApiKey = baseApi?.apiKey || apiKey || "";
          const providerBaseUrl = baseApi?.url || baseApi?.baseURL || effectiveBaseUrl || llmBaseUrl;

          if (verbose) {
            console.log("[kimchi] models hook - baseApi?.apiKey:", baseApi?.apiKey ? "set" : "not set");
            console.log("[kimchi] models hook - providerApiKey:", providerApiKey ? "set" : "NOT SET");
            console.log("[kimchi] models hook - providerBaseUrl:", providerBaseUrl);
          }

          // Each model needs its own api object with the correct api.id,
          // because OpenCode uses api.id as the model parameter sent to the
          // AI SDK (sdk.chatModel(model.api.id)). If all models share the
          // same api.id, every model resolves to the same underlying LLM.
          function apiFor(modelId: string) {
            // Start with base API template if available, or create minimal one
            const base = baseApi ?? {
              id: modelId,
              url: providerBaseUrl,
              npm: "@ai-sdk/openai-compatible",
            };
            
            // Always include apiKey and url explicitly - use values from provider config
            return { 
              ...base, 
              id: modelId,
              apiKey: providerApiKey,
              url: providerBaseUrl,
            };
          }

         const defaultModel = registry.getForTier("coding");
         if (defaultModel) {
           result["auto"] = {
             api: apiFor("auto"),
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
            api: apiFor(model.id),
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
              api: apiFor(model.id),
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
              status: registry.getDeprecationStatus(model.id, now) === "active" ? "active" : "deprecated",
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
       let modelsLoaded = false;
       
        // Try to load models from Kimchi API first if we have an API key
        // Priority: 1) Plugin options, 2) OpenCode provider config, 3) Already set from env/defaults
        const apiKeyForModels = (options?.apiKey as string) 
          ?? providerConfig?.options?.apiKey 
          ?? apiKey;
        
         // Determine baseURL priority: 1) Plugin options, 2) Provider config, 3) Default
         // Update the outer effectiveBaseUrl so provider.models can use it
         effectiveBaseUrl = (options?.llmBaseUrl as string)
           ?? providerConfig?.options?.baseURL
           ?? effectiveBaseUrl;
        
        if (apiKeyForModels) {
          try {
            // The baseURL points to the OpenAI-compatible endpoint (e.g., /openai/v1)
            // but the models metadata API is at the root, so we strip the path suffix
            let modelsApiUrl = effectiveBaseUrl;
            if (modelsApiUrl?.includes("/openai/v1")) {
              modelsApiUrl = modelsApiUrl.replace("/openai/v1", "");
            }
            
            const result = await registry.loadFromApi({
              baseUrl: modelsApiUrl,
              apiKey: apiKeyForModels,
              timeoutMs: 10000
            });
           
           if (result.success) {
             profiles = resolveProfiles(registry);
             log(verbose, `loaded ${result.loaded} models from Kimchi API`);
             modelsLoaded = true;
           } else {
             log(verbose, `failed to load models from Kimchi API: ${result.warnings.join(", ")}`);
           }
         } catch (error) {
           log(verbose, `error loading models from Kimchi API: ${error}`);
         }
       }
       
       // Fall back to loading from config if API loading failed or no API key
       if (!modelsLoaded && providerConfig?.models && typeof providerConfig.models === "object") {
         registry.loadFromConfig(providerID, providerConfig.models);
         profiles = resolveProfiles(registry);
         log(verbose, `loaded ${registry.all().length} models from config`);
       }

       // Update apiKey from provider config if different (takes precedence over plugin options/env)
       // effectiveBaseUrl was already updated above to include provider config
       const providerApiKey = providerConfig?.options?.apiKey;
       if (providerApiKey && providerApiKey !== apiKey) {
         apiKey = providerApiKey;
         telemetryConfig.headers["Authorization"] = `Bearer ${apiKey}`;
       }
       
       // Also update llmBaseUrl for LLM classifier to use the same effectiveBaseUrl
       llmBaseUrl = effectiveBaseUrl;

      const autoModel = `${providerID}/auto`;

      if (!config.agent) config.agent = {};

      const subagentNames = ["explore", "general"];
      const dynamicPrompt = buildKimchiAutoPrompt({
        registry,
        providerID,
        subagents: subagentNames,
      });

      // Determine the model for the primary agent.
      // If the user has explicitly configured a specific kimchi model in config.model
      // (not auto, not a tier alias), honour it by passing it through to the agent.
      // This ensures OpenCode dispatches messages with the user's chosen model,
      // which the hooks can then detect and respect.
      let primaryModel = autoModel;
      if (config.model && typeof config.model === "string") {
        const userModel = config.model;
        const isKimchiModel = userModel.startsWith(`${providerID}/`);
        if (isKimchiModel) {
          const modelIdPart = userModel.slice(providerID.length + 1);
          const isVirtual = modelIdPart === "auto" || modelIdPart === "reasoning" || modelIdPart === "coding" || modelIdPart === "quick";
          if (!isVirtual) {
            primaryModel = userModel;
            log(verbose, `user configured explicit model: ${userModel}, using as primary agent model`);
          }
        }
      }

      if (!config.agent[KIMCHI_AGENT_NAME]) {
        config.agent[KIMCHI_AGENT_NAME] = {
          model: primaryModel,
          mode: "primary",
          prompt: dynamicPrompt,
          description: KIMCHI_AGENT_DESCRIPTION,
          color: "accent",
        };
      }

      config.default_agent = KIMCHI_AGENT_NAME;

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
        const inputModelID = getModelID(input as any);
        log(verbose, `chat.message: inputProviderID=${inputProviderID}, inputModelID=${inputModelID}`);
        if (inputProviderID && inputProviderID !== providerID) {
          log(verbose, `chat.message: provider mismatch, returning`);
          return;
        }

        const text = extractText(output?.parts);
        const sessionID = getSessionID(input as any);
        log(verbose, `chat.message: sessionID=${sessionID}`);
        if (!sessionID) return;

        const now = new Date();

        if (hasPendingFallback(sessionID)) {
          const fallbackModel = getNextFallbackModel(sessionID, registry);
          const fallbackState = consumePendingFallback(sessionID);
          if (fallbackModel && fallbackState) {
            const profileId = TIER_TO_PROFILE[fallbackModel.tier];
            setActiveProfile(sessionID, profileId);
            recordDecision(sessionID, { profile: profileId, source: `fallback: ${fallbackState.failedModelID} → ${fallbackModel.id}` });
            output.message.model = { providerID, modelID: fallbackModel.id };
            log(verbose, `fallback: ${fallbackState.failedModelID} failed, switching to ${fallbackModel.id}`);
            showRouting(client, profileId, fallbackModel.id, fallbackModel.tier, `fallback: ${fallbackState.failedModelID} failed`, sessionID);
            warnIfDeprecated(sessionID, fallbackModel, now, client);
            return;
          }
          log(verbose, `fallback chain exhausted for session ${sessionID}, no more models to try`);
          clearFallbackState(sessionID);
        }

        const command = parseCommand(text);
        if (command === "auto") {
          setOverride(sessionID, null);
          clearSelectedModel(sessionID);
          showRouting(client, "assistant", "auto", "auto", "override: auto", sessionID);
        } else if (command) {
          setOverride(sessionID, command);
        }

        const agentName = (input as any).agent as string | undefined;

        // System agents (title, summary, compaction) must not mutate primary routing state.
        // They resolve their own model from their tier and return immediately.
        if (agentName && isSystemAgent(agentName)) {
          const agentRouting = getAgentRouting(agentName);
          if (agentRouting) {
            const tier = agentRouting.tier;
            const model = registry.getForTier(tier);
            if (model) {
              output.message.model = { providerID, modelID: model.id };
            }
            log(verbose, `-> system agent ${agentName}: ${model?.id ?? tier} (no state mutation)`);
          }
          return;
        }

        // Only set activeAgent for non-system agents (preserves primary agent identity)
        if (agentName) {
          setActiveAgent(sessionID, agentName);
        }

        // Check for explicit model selection FIRST (before agent routing)
        // This ensures user-selected models take precedence over agent defaults
        const isTierSelect = inputModelID === "reasoning" || inputModelID === "coding" || inputModelID === "quick";

        if (isTierSelect) {
          const tier = inputModelID as ModelTier;
          const model = registry.getForTier(tier);
          const profileId = TIER_TO_PROFILE[tier];
          setActiveProfile(sessionID, profileId);
          if (model) {
            setSelectedModel(sessionID, model.id);
            output.message.model = { providerID, modelID: model.id };
          }
          recordDecision(sessionID, { profile: profileId, source: `direct: ${tier}` });
          log(verbose, `-> ${profileId} (direct ${tier} selection)`);
          showRouting(client, profileId, model?.id ?? tier, tier, `direct: ${tier}`, sessionID);
          warnIfDeprecated(sessionID, model, now, client);
          return;
        }

        const isAutoRouted = !inputModelID || inputModelID === "auto";

        // Check for a previous explicit user selection (set by tier-select or
        // explicit model pick). If present, honour it regardless of what
        // inputModelID says — the user's choice is authoritative.
        // We set output.message.model here so the TUI keeps showing the
        // user's chosen model.
        const previousSelection = getSelectedModel(sessionID);
        if (previousSelection) {
          const prevModel = registry.get(previousSelection);
          if (prevModel) {
            const profileId = TIER_TO_PROFILE[prevModel.tier];
            setActiveProfile(sessionID, profileId);
            output.message.model = { providerID, modelID: previousSelection };
            recordDecision(sessionID, { profile: profileId, source: `direct: ${previousSelection} (persisted)` });
            log(verbose, `-> persisted explicit model: ${previousSelection} (skipping auto-routing)`);
            showRouting(client, profileId, previousSelection, prevModel.tier, `direct: ${previousSelection}`, sessionID);
            return;
          }
        }

        // Auto-echo detection: when auto-routing resolves a model and sets it
        // on the message, the TUI may display it and send it back on the next
        // prompt. If the session has auto-routed (activeProfile set) but the
        // user never explicitly selected a model (selectedModel null), any
        // known model ID is just a TUI echo — fall through to auto-routing.
        const currentSession = getSession(sessionID);
        const hasAutoRouted = currentSession.activeProfile !== null && !previousSelection;
        const strippedInput = inputModelID?.startsWith(`${providerID}/`)
          ? inputModelID.slice(providerID.length + 1) : (inputModelID ?? "");
        const isKnownModel = !isAutoRouted && registry.get(strippedInput) !== undefined;
        const isAutoEcho = hasAutoRouted && isKnownModel;
        if (isAutoEcho) {
          log(verbose, `auto-echo: inputModelID=${inputModelID} is TUI echo, treating as auto-routing`);
        }

        if (!isAutoRouted && !isAutoEcho) {
          // Strip provider prefix if present (e.g., "kimchi/minimax-m2.7" -> "minimax-m2.7")
          const modelIdWithoutPrefix = inputModelID!.startsWith(`${providerID}/`)
            ? inputModelID!.slice(providerID.length + 1)
            : inputModelID!;
          const knownModel = registry.get(modelIdWithoutPrefix);
          log(verbose, `explicit model selection: input=${inputModelID}, stripped=${modelIdWithoutPrefix}, found=${knownModel?.id ?? 'null'}`);
          if (knownModel) {
            // Store the selected model and set the profile for the model's tier.
            // output.message.model is the ONLY way to control which model OpenCode
            // sends the request to. activeProfile provides context for system prompts,
            // cost tracking, and compaction.
            setSelectedModel(sessionID, knownModel.id);
            const profileId = TIER_TO_PROFILE[knownModel.tier];
            setActiveProfile(sessionID, profileId);
            log(verbose, `stored selected model: ${knownModel.id} (profile: ${profileId}) for session ${sessionID}`);
            output.message.model = { providerID, modelID: knownModel.id };
            log(verbose, `-> direct model: ${knownModel.id} (bypassing auto-routing)`);
            recordDecision(sessionID, { profile: profileId, source: `direct: ${knownModel.id}` });
            showRouting(client, profileId, knownModel.id, knownModel.tier, `direct: ${knownModel.id}`, sessionID);
            warnIfDeprecated(sessionID, knownModel, now, client);
          } else {
            log(verbose, `model not found in registry: ${modelIdWithoutPrefix}`);
          }
          // CRITICAL: Return here to prevent any further processing
          log(verbose, `explicit model selection: RETURNING NOW - no routing logic will run`);
          return;
        }
        
        // If we reach here, auto-routing is active - log this clearly
        log(verbose, `AUTO-ROUTING ACTIVE: isAutoRouted=${isAutoRouted}, proceeding with classification`);

        // Agent routing for subagents (explore, general, title, summary, compaction)
        // This runs AFTER explicit model selection, so user-selected models take precedence
        const agentRouting = agentName ? getAgentRouting(agentName) : undefined;
        if (agentRouting && shouldSkipClassification(agentName!)) {
          const tier = agentRouting.tier;
          const model = registry.getForTier(tier);
          const profileId = TIER_TO_PROFILE[tier];
          setActiveProfile(sessionID, profileId);
          // Don't set output.message.model — chat.params handles the actual
          // model via providerOptions. This keeps the TUI display unchanged.
          recordDecision(sessionID, { profile: profileId, source: `agent: ${agentName} → ${tier}` });
          log(verbose, `-> ${profileId} (agent: ${agentName})`);
          showRouting(client, profileId, model?.id ?? tier, tier, `agent: ${agentName}`, sessionID);
          warnIfDeprecated(sessionID, model, now, client);
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

        const agentForFloor = getSession(sessionID).activeAgent;
        const isPrimaryForFloor = !agentForFloor || isPrimaryAgent(agentForFloor);
        if (isPrimaryForFloor && profile.tier === "quick") {
          log(verbose, `primary agent floored from quick (${profile.id}) to coding (coder)`);
          profile = profiles.coder;
          source = `floored: ${source} → coder (primary agents skip quick tier)`;
        }

        setActiveProfile(sessionID, profile.id);
        recordDecision(sessionID, { profile: profile.id, source });
        log(verbose, `-> ${profile.label} | ${source}`);
        
        // Resolve the model for display/logging. Don't set output.message.model —
        // that would change the TUI from "auto" to the resolved model. Instead,
        // chat.params will set output.options.model which overrides the model
        // parameter in the API request via providerOptions.
        let resolvedModel = registry.getForTier(profile.tier);

        // Context-window upgrade: if usage exceeds 85% of the current model's
        // context window, try to find a larger model in the same tier.
        const session = getSession(sessionID);
        if (resolvedModel && session.estimatedContextTokens > 0) {
          const contextLimit = resolvedModel.contextWindow;
          const usageRatio = session.estimatedContextTokens / contextLimit;
          if (usageRatio > 0.85) {
            const upgrade = registry.findModelForContext(profile.tier, session.estimatedContextTokens);
            if (upgrade && upgrade.id !== resolvedModel.id) {
              log(verbose, `context ${session.estimatedContextTokens} tokens exceeds 85% of ${resolvedModel.id} (${contextLimit}), upgrading to ${upgrade.id} (${upgrade.contextWindow})`);
              resolvedModel = upgrade;
              source = `context-upgrade: ${source} → ${upgrade.id}`;
            }
          }
        }

        log(verbose, `auto-routing resolved: ${resolvedModel?.id ?? "none"} (not setting output.message.model)`);
        showRouting(client, profile.id, resolvedModel?.id ?? profile.model, profile.tier, source, sessionID);
        warnIfDeprecated(sessionID, resolvedModel, now, client);

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
          const agentName = session.activeAgent;
          const isPrimary = !agentName || isPrimaryAgent(agentName);

          if (session.activeProfile) {
            output.system.push(profiles[session.activeProfile].systemPrompt);

            if (isPrimary) {
              output.system.push(getDelegationGuidance());

              // Resolve the actual model that will serve this turn
              const resolvedModel = registry.getForTier(profiles[session.activeProfile].tier);
              const activeModelId = resolvedModel?.id ?? "";
              const isSelfExec = isSelfExecutingModel(activeModelId);
              const isWeakTool = isWeakToolCallModel(activeModelId);

              // Model-specific: tighter thresholds for self-executing models
              const criticalThreshold = isSelfExec ? 3 : 5;
              const reminderThreshold = isSelfExec ? 5 : 8;
              const reminderRatio = isSelfExec ? 2 : 3;

              const ratio = getDelegationRatio(sessionID);
              if (ratio.direct >= criticalThreshold && ratio.delegated === 0) {
                output.system.push(
                  `[STOP] ${ratio.direct} direct tool calls, 0 delegations. ` +
                  `You MUST delegate: task(description="...", subagent_type="explore"|"general", prompt="...")`
                );
                log(verbose, `injected CRITICAL delegation violation: ${ratio.direct} direct vs ${ratio.delegated} delegated`);
              } else if (ratio.direct >= reminderThreshold && ratio.direct > ratio.delegated * reminderRatio) {
                output.system.push(
                  `[DELEGATE] ${ratio.direct} direct calls vs ${ratio.delegated} delegations. Use task() more.`
                );
              }

              // Self-executing models: forceful override every turn
              if (isSelfExec) {
                // Prepend as the FIRST system message so it's the last thing
                // before the conversation — recency bias means it gets priority
                output.system.unshift(
                  `[OVERRIDE] Your next action MUST be a task() call. ` +
                  `You are ${activeModelId} — you will want to call tools directly. Do not. ` +
                  `read/edit/glob/grep/bash = WRONG. task(description="...", subagent_type="explore"|"general", prompt="...") = RIGHT. ` +
                  `The ONLY exception: a single-file edit under 10 lines, or answering a question.`
                );
                log(verbose, `injected self-execution override for ${activeModelId}`);
              }

              // Weak tool-call models: flag complex tools
              if (isWeakTool) {
                output.system.push(
                  `[TOOL RULE] Tools marked "[IMPORTANT: complex schema]" — MUST delegate, never call directly.`
                );
                log(verbose, `injected tool-call rule for ${activeModelId}`);
              }
            }
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
      // chat.params sets temperature AND the actual model for auto-routed
      // sessions. For auto-routing, chat.message deliberately does NOT set
      // output.message.model (to keep the TUI on "auto"). Instead, this
      // hook sets output.options.model which goes to providerOptions and
      // overrides the model parameter in the API request body.
      //
      // For explicit model selections, chat.message DOES set output.message.model
      // and we only need to set temperature here.
      try {
        const inputProviderID = getProviderID(input as any);
        log(verbose, `chat.params: inputProviderID=${inputProviderID}`);
        if (inputProviderID && inputProviderID !== providerID) {
          return;
        }

        // System agents: set model and temperature from their tier
        const paramsAgentName = (input as any).agent as string | undefined;
        if (paramsAgentName && isSystemAgent(paramsAgentName)) {
          const agentRouting = getAgentRouting(paramsAgentName);
          if (agentRouting) {
            const model = registry.getForTier(agentRouting.tier);
            if (model) {
              output.options = { ...output.options, model: model.id };
              output.temperature = safeTemperature(0.5, model);
              log(verbose, `chat.params: system agent ${paramsAgentName} -> model=${model.id}, temp=${output.temperature}`);
            }
          }
          return;
        }

        const now = new Date();

        const sessionID = getSessionID(input as any);
        if (!sessionID) return;

        const session = getSession(sessionID);
        const selectedModel = getSelectedModel(sessionID);

        // Explicit model selection: chat.message already set output.message.model.
        // We only need temperature.
        if (selectedModel) {
          const modelEntry = registry.get(selectedModel);
          const profileId = modelEntry ? TIER_TO_PROFILE[modelEntry.tier] : null;
          const temp = profileId ? profiles[profileId].temperature : 0.6;
          output.temperature = safeTemperature(temp, modelEntry);
          log(verbose, `chat.params: explicit model=${selectedModel}, temp=${output.temperature}`);
          warnIfDeprecated(sessionID, modelEntry, now, client);
          return;
        }

        // Auto-routed session: resolve the model from the active profile and
        // set output.options.model to override the API request model parameter.
        if (session.activeProfile) {
          const activeProfile = profiles[session.activeProfile];
          let resolvedModel = registry.getForTier(activeProfile.tier);

          // Context-window upgrade
          if (resolvedModel && session.estimatedContextTokens > 0) {
            const contextLimit = resolvedModel.contextWindow;
            const usageRatio = session.estimatedContextTokens / contextLimit;
            if (usageRatio > 0.85) {
              const upgrade = registry.findModelForContext(activeProfile.tier, session.estimatedContextTokens);
              if (upgrade && upgrade.id !== resolvedModel.id) {
                log(verbose, `chat.params: context upgrade ${resolvedModel.id} -> ${upgrade.id}`);
                resolvedModel = upgrade;
              }
            }
          }

          if (resolvedModel) {
            output.options = { ...output.options, model: resolvedModel.id };
            output.temperature = safeTemperature(activeProfile.temperature, resolvedModel);
            log(verbose, `chat.params: auto-routed model=${resolvedModel.id}, temp=${output.temperature}`);
            warnIfDeprecated(sessionID, resolvedModel, now, client);
          }
          return;
        }

        // Fallback: try to match the model to a profile for temperature
        const messageModelID = (input as any).message?.model?.modelID as string | undefined;
        if (messageModelID) {
          const modelEntry = registry.get(messageModelID);
          if (modelEntry) {
            const profileId = TIER_TO_PROFILE[modelEntry.tier];
            output.temperature = safeTemperature(profiles[profileId].temperature, modelEntry);
          }
        }
      } catch (err) {
        log(verbose, `chat.params error: ${err}`);
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        const toolName = (input.tool ?? "").toLowerCase();
        await telemetry.handleToolAfter(
          { tool: toolName, args: input.args as Record<string, unknown> },
          { result: output.output }
        );
        const filePath = extractFilePath(input.args);

        const trackingAgent = getSession(input.sessionID).activeAgent;
        const isTrackingPrimary = !trackingAgent || isPrimaryAgent(trackingAgent);
        if (isTrackingPrimary) {
          if (DELEGATION_TOOLS.has(toolName)) {
            trackDelegationToolCall(input.sessionID);
          } else if (DIRECT_WORK_TOOLS.has(toolName)) {
            trackDirectToolCall(input.sessionID);
          }
        }

        if (EDIT_TOOLS.has(toolName)) {
          incrementLiveSignal(input.sessionID, "edits");
          if (filePath) trackFileModified(input.sessionID, filePath);
        }
        if (READ_TOOLS.has(toolName)) {
          incrementLiveSignal(input.sessionID, "reads");
          if (filePath) trackFileRead(input.sessionID, filePath);
        }
        if (ERROR_PATTERN.test(output.output ?? "")) {
          incrementLiveSignal(input.sessionID, "errors");
          const errorLine = (output.output ?? "").split("\n").find((l: string) => ERROR_PATTERN.test(l));
          if (errorLine) trackToolError(input.sessionID, errorLine.trim());
        }

        const sessionAgent = getSession(input.sessionID).activeAgent;
        const isSessionPrimary = !sessionAgent || isPrimaryAgent(sessionAgent);

        // Resolve the active model for model-specific behaviour
        const activeSession = getSession(input.sessionID);
        const activeProfileForTool = activeSession.activeProfile ? profiles[activeSession.activeProfile] : null;
        const resolvedModelForTool = activeProfileForTool ? registry.getForTier(activeProfileForTool.tier) : undefined;
        const activeModelIdForTool = resolvedModelForTool?.id ?? "";
        const isWeakToolModel = isWeakToolCallModel(activeModelIdForTool);
        const isSelfExecModel = isSelfExecutingModel(activeModelIdForTool);

        // For weak-tool-call models calling complex tools:
        // 1. On failure (param error) → strong "delegate instead" correction
        // 2. On success → still remind them to delegate next time (the call worked
        //    this time but may not next time, and it wastes orchestrator tokens)
        if (isWeakToolModel && isSessionPrimary && complexToolIDs.has(toolName)) {
          const outputStr = output.output ?? "";
          const hasParamError = /\b(?:invalid.*param|missing.*(?:required|param)|unexpected.*(?:field|property)|schema.*(?:error|invalid|mismatch)|malformed|argument.*(?:error|invalid|required))\b/i.test(outputStr);
          if (hasParamError) {
            output.output = outputStr + "\n\n" +
              `[FAILED — DELEGATE] ${toolName} call failed. Do not retry. Delegate:\n` +
              `task(description="Call ${toolName}", subagent_type="general", prompt="Use ${toolName} to [goal]. Params: [details]")`;
            log(verbose, `tool-call delegation after param error on ${toolName}`);
          } else {
            output.output = outputStr + "\n\n" +
              `[DELEGATE NEXT TIME] ${toolName} is a complex tool. Future calls must use:\n` +
              `task(description="Call ${toolName}", subagent_type="general", prompt="Use ${toolName} to [goal]. Params: [details]")`;
            log(verbose, `complex-tool reminder after ${toolName} call`);
          }
        }

        // Delegation reminders — fire earlier and harder for self-executing models
        if (isSessionPrimary && shouldInjectDelegationReminder(input.sessionID, isSelfExecModel)) {
          const reminder = isSelfExecModel
            ? `[WRONG] You called ${toolName} directly. You must not do this. ` +
              `Your next action MUST be: task(description="...", subagent_type="explore"|"general", prompt="..."). ` +
              `Do NOT call read, edit, write, glob, grep, or bash directly.`
            : DELEGATION_REMINDER;
          output.output = (output.output ?? "") + "\n\n" + reminder;
          markReminderInjected(input.sessionID);
          log(verbose, `injected delegation reminder for session ${input.sessionID} (aggressive=${isSelfExecModel})`);
        }

        const session = getSession(input.sessionID);
        const activeProfile = session.activeProfile ? profiles[session.activeProfile] : null;
        if (shouldTriggerProactiveCompaction(input.sessionID, session.estimatedContextTokens, registry, activeProfile)) {
          log(verbose, `context at ${Math.round(session.estimatedContextTokens / 1000)}K tokens, triggering proactive compaction`);
          showRouting(client, session.activeProfile ?? "assistant", "compacting", activeProfile?.tier ?? "coding", "proactive-compaction", input.sessionID);
          triggerProactiveCompaction(
            input.sessionID,
            client,
            ctx.directory,
            (msg) => log(verbose, msg),
          ).catch(() => {});
        }
      } catch (err) {
        log(verbose, `tool.execute.after error: ${err}`);
      }
    },

    "experimental.session.compacting": async (input, output) => {
      try {
        const session = getSession(input.sessionID);
        const contextLines = buildCompactionContext(session, profiles);
        for (const line of contextLines) {
          output.context.push(line);
        }
        output.prompt = buildCompactionPrompt();
      } catch (err) {
        log(verbose, `session.compacting error: ${err}`);
      }
    },

    event: async ({ event }) => {
      try {
        const props = (event as any).properties;
        await telemetry.handleEvent({ type: event.type, properties: props });

        if (event.type === "session.compacted") {
          const sessionID = props?.sessionID as string | undefined;
          if (sessionID) {
            resetContextEstimate(sessionID);
            log(verbose, `context estimate reset after compaction for session ${sessionID}`);
          }
          return;
        }

        if (event.type === "session.error") {
          const sessionID = props?.sessionID as string | undefined;
          const error = props?.error as { name: string; data: Record<string, unknown> } | undefined;
          if (!sessionID || !error) return;

          const session = getSession(sessionID);
          const activeTier = session.activeProfile
            ? profiles[session.activeProfile]?.tier ?? "coding"
            : "coding";
          const currentModel = session.activeProfile
            ? profiles[session.activeProfile]?.model ?? "unknown"
            : "unknown";

          const armed = onSessionError(sessionID, error, currentModel, activeTier);
          if (armed) {
            const nextModel = getNextFallbackModel(sessionID, registry);
            log(verbose, `session.error: ${error.name} on ${currentModel}, fallback armed → ${nextModel?.id ?? "exhausted"}`);
            if (nextModel) {
              client?.tui?.showToast({
                body: {
                  title: "Kimchi: Model error",
                  message: `${currentModel} failed (${error.name}), will retry with ${nextModel.id}`,
                  variant: "warning" as const,
                  duration: 5000,
                },
              }).catch(() => {});
            }
          } else {
            log(verbose, `session.error: ${error.name} on ${currentModel}, not retryable`);
          }
          return;
        }

        if (event.type !== "message.updated") return;
        if (!props?.info) return;

        const info = props.info;
        if (info.role !== "assistant") return;
        if (info.providerID !== providerID) return;
        if (!info.id || !info.sessionID) return;

        const session = getSession(info.sessionID);
        const activeTier = session.activeProfile
          ? profiles[session.activeProfile]?.tier ?? "coding"
          : "coding";

        const inputTokens = info.tokens?.input ?? 0;
        const outputTokens = info.tokens?.output ?? 0;

        const activeModel = session.activeProfile
          ? profiles[session.activeProfile]?.model
          : undefined;

        recordMessageCost(
          info.sessionID,
          info.id,
          activeTier,
          info.cost ?? 0,
          inputTokens,
          outputTokens,
          session.activeAgent ?? undefined,
          activeModel ?? info.modelID,
        );

        if (inputTokens > 0) {
          updateContextEstimate(info.sessionID, inputTokens + outputTokens);
        }

        if (info.sessionID && !info.error && info.finish) {
          clearFallbackState(info.sessionID);
        }
      } catch (err) {
        log(verbose, `event error: ${err}`);
      }
    },

    "tool.definition": async (input, output) => {
      try {
        if (input.toolID === "task") {
          output.description = getTaskToolEnhancement() + "\n\n" + output.description;
        }

        // Schema-based complexity check: flag tools whose schemas are complex
        // (many params, nested objects, combinators, large enums).
        // For weak-tool-call models, prepend a delegation warning so the model
        // sees it right in the tool definition before deciding to call it.
        if (isComplexTool(input.toolID, output.parameters)) {
          complexToolIDs.add(input.toolID);
          if (hasWeakToolCallModels(registry)) {
            output.description = getComplexToolWarning(input.toolID) + output.description;
          }
          log(verbose, `tool.definition: flagged ${input.toolID} as complex (schema-based)`);
        }
      } catch (err) {
        log(verbose, `tool.definition error: ${err}`);
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
export { getAgentRouting, shouldSkipClassification, isSystemAgent } from "./agent-router.js";
export { KIMCHI_AGENT_NAME } from "./kimchi-agent.js";
export type { ProfileID, AgentProfile } from "./profiles.js";
export type { ModelTier, KimchiModel } from "./model-registry.js";
export type { ConversationPhase, PhaseDetectionResult } from "./phase-detector.js";
export type { TelemetryConfig, TelemetryClient, Telemetry, TelemetryPluginOption } from "./telemetry.js";
