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
} from "./session-state.js";
import {
  getAgentRouting,
  shouldSkipClassification,
  isPrimaryAgent,
  getTaskToolEnhancement,
  getDelegationGuidance,
} from "./agent-router.js";
import {
  KIMCHI_AGENT_NAME,
  KIMCHI_AGENT_DESCRIPTION,
  buildKimchiAutoPrompt,
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

const DELEGATION_REMINDER = `[Delegation Reminder] You are using tools directly instead of delegating to subagents.

As an orchestrator, you should:
- Delegate codebase search to @explore: task(subagent_type="explore", load_skills=[], run_in_background=true, prompt="...")
- Delegate implementation to subagents: task(category="quick", load_skills=[], run_in_background=false, prompt="1. TASK: ... 2. EXPECTED OUTCOME: ... 3. MUST DO: ... 4. CONTEXT: ...")
- Only use tools directly for trivial changes (< 20 lines, single file)

If you're reading files to understand the codebase → delegate to @explore.
If you're editing multiple files → delegate via task().`;
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

  const llmBaseUrl = (options?.llmBaseUrl as string) ?? CASTAI_LLM_BASE;
  const llmClassifierEnabled = (options?.llmClassifier as boolean) ?? true;
  const llmClassifierThreshold = (options?.llmClassifierThreshold as number) ?? 0.5;
  let apiKey = (options?.apiKey as string) ?? process.env.CASTAI_API_KEY;

  const telemetryConfig = buildTelemetryConfig({ ...(options as TelemetryPluginOption | undefined), apiKey }, verbose);
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
        // Update telemetry config with the new API key
        telemetryConfig.headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const autoModel = `${providerID}/auto`;

      if (!config.agent) config.agent = {};

      const subagentNames = ["explore", "general"];
      const dynamicPrompt = buildKimchiAutoPrompt({
        registry,
        providerID,
        subagents: subagentNames,
      });

      if (!config.agent[KIMCHI_AGENT_NAME]) {
        config.agent[KIMCHI_AGENT_NAME] = {
          model: autoModel,
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
          }
          recordDecision(sessionID, { profile: profileId, source: `direct: ${tier}` });
          log(verbose, `-> ${profileId} (direct ${tier} selection)`);
          showRouting(client, profileId, model?.id ?? tier, tier, `direct: ${tier}`, sessionID);
          return;
        }

        const isAutoRouted = !inputModelID || inputModelID === "auto";

        if (!isAutoRouted) {
          // Strip provider prefix if present (e.g., "kimchi/minimax-m2.7" -> "minimax-m2.7")
          const modelIdWithoutPrefix = inputModelID!.startsWith(`${providerID}/`)
            ? inputModelID!.slice(providerID.length + 1)
            : inputModelID!;
          const knownModel = registry.get(modelIdWithoutPrefix);
          log(verbose, `explicit model selection: input=${inputModelID}, stripped=${modelIdWithoutPrefix}, found=${knownModel?.id ?? 'null'}`);
          if (knownModel) {
            // Store the selected model and set output model
            // DO NOT set activeProfile - this bypasses all routing logic
            setSelectedModel(sessionID, knownModel.id);
            log(verbose, `stored selected model: ${knownModel.id} for session ${sessionID}`);
            output.message.model = { providerID, modelID: knownModel.id };
            log(verbose, `-> direct model: ${knownModel.id} (bypassing all routing)`);
            showRouting(client, "direct", knownModel.id, knownModel.tier, `direct: ${knownModel.id}`, sessionID);
          } else {
            log(verbose, `model not found in registry: ${modelIdWithoutPrefix}`);
          }
          return;
        }

        // Agent routing for subagents (explore, general, title, summary, compaction)
        // This runs AFTER explicit model selection, so user-selected models take precedence
        const agentRouting = agentName ? getAgentRouting(agentName) : undefined;
        if (agentRouting && shouldSkipClassification(agentName!)) {
          const tier = agentRouting.tier;
          const model = registry.getForTier(tier);
          const profileId = TIER_TO_PROFILE[tier];
          setActiveProfile(sessionID, profileId);
          recordDecision(sessionID, { profile: profileId, source: `agent: ${agentName} → ${tier}` });
          log(verbose, `-> ${profileId} (agent: ${agentName})`);
          showRouting(client, profileId, model?.id ?? tier, tier, `agent: ${agentName}`, sessionID);
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
        
        // Check if there's a selected model that matches this profile's tier
        // If so, use the selected model instead of the profile default
        const selectedModel = getSelectedModel(sessionID);
        log(verbose, `chat.message: selectedModel=${selectedModel}, profile.id=${profile.id}, profile.tier=${profile.tier}`);
        let displayModel = profile.model;
        if (selectedModel) {
          const selectedModelEntry = registry.get(selectedModel);
          log(verbose, `chat.message: selectedModelEntry=${selectedModelEntry?.id}, tier=${selectedModelEntry?.tier}`);
          if (selectedModelEntry) {
            const selectedModelProfile = TIER_TO_PROFILE[selectedModelEntry.tier];
            log(verbose, `chat.message: selectedModelProfile=${selectedModelProfile}, profile.id=${profile.id}, match=${selectedModelProfile === profile.id}`);
            if (selectedModelProfile === profile.id) {
              displayModel = selectedModel;
              log(verbose, `using selected model ${selectedModel} for profile ${profile.id}`);
            }
          }
        }
        showRouting(client, profile.id, displayModel, profile.tier, source, sessionID);


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

              const ratio = getDelegationRatio(sessionID);
              if (ratio.direct >= 5 && ratio.delegated === 0) {
                output.system.push(
                  `[CRITICAL VIOLATION] You have made ${ratio.direct} direct tool calls and ZERO delegations. ` +
                  `You are violating the Delegation Contract. ` +
                  `STOP immediately. ` +
                  `MUST NOT: Write code, perform file operations, execute commands directly. ` +
                  `MUST: Delegate to @explore, @general, or task(). ` +
                  `MAY ONLY execute directly if: < 10 lines AND single file, OR user explicitly requests.`
                );
                log(verbose, `injected CRITICAL delegation violation warning: ${ratio.direct} direct vs ${ratio.delegated} delegated`);
              } else if (ratio.direct >= 8 && ratio.direct > ratio.delegated * 3) {
                output.system.push(
                  `[DELEGATION REMINDER] Your direct tool usage (${ratio.direct}) is much higher than delegations (${ratio.delegated}). ` +
                  `Per the Delegation Contract: Delegate to @explore for search, @general for research, task() for implementation. ` +
                  `Only execute directly for: < 10 lines AND single file, OR coordination, OR explicit user request.`
                );
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
      try {
        const inputProviderID = getProviderID(input as any);
        const inputModelID = getModelID(input as any);
        log(verbose, `chat.params: inputProviderID=${inputProviderID}, inputModelID=${inputModelID}`);
        if (inputProviderID && inputProviderID !== providerID) {
          log(verbose, `chat.params: provider mismatch, returning`);
          return;
        }

        const sessionID = getSessionID(input as any);
        log(verbose, `chat.params: sessionID=${sessionID}`);

        // FIRST: Check if user explicitly selected a specific model
        // If so, use it directly and bypass ALL routing logic
        if (sessionID) {
          const selectedModel = getSelectedModel(sessionID);
          if (selectedModel) {
            log(verbose, `chat.params: using explicitly selected model=${selectedModel} (bypassing all routing)`);
            output.options = { ...output.options, model: selectedModel };
            // Use default temperature since we're bypassing profile
            output.temperature = 0.6;
            log(verbose, `chat.params: output.options set with selected model, returning`);
            return;
          }
        }

        // SECOND: Fall back to profile-based routing (for auto/tier selections)
        if (sessionID) {
          const session = getSession(sessionID);
          log(verbose, `chat.params: session found, activeProfile=${session.activeProfile}`);
          if (session.activeProfile) {
            const activeProfile = profiles[session.activeProfile];
            let resolvedModel = activeProfile.model;
            log(verbose, `chat.params: resolvedModel=${resolvedModel}`);

            if (session.estimatedContextTokens > 0) {
              const modelEntry = registry.get(resolvedModel);
              const contextLimit = modelEntry?.contextWindow ?? 128_000;
              const usageRatio = session.estimatedContextTokens / contextLimit;

              if (usageRatio > 0.85) {
                const upgrade = registry.findModelForContext(
                  activeProfile.tier,
                  session.estimatedContextTokens,
                );
                if (upgrade && upgrade.id !== resolvedModel) {
                  log(verbose, `context ${session.estimatedContextTokens} tokens exceeds 85% of ${resolvedModel} (${contextLimit}), upgrading to ${upgrade.id} (${upgrade.contextWindow})`);
                  resolvedModel = upgrade.id;
                  showRouting(client, activeProfile.id, resolvedModel, activeProfile.tier, `context-upgrade: ${resolvedModel}`, sessionID);
                }
              }
            }

            output.temperature = activeProfile.temperature;
            log(verbose, `chat.params: setting output.options.model=${resolvedModel}`);
            output.options = { ...output.options, model: resolvedModel };
            log(verbose, `chat.params: output.options set, returning`);
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
        if (isSessionPrimary && shouldInjectDelegationReminder(input.sessionID)) {
          output.output = (output.output ?? "") + "\n\n" + DELEGATION_REMINDER;
          markReminderInjected(input.sessionID);
          log(verbose, `injected delegation reminder for session ${input.sessionID}`);
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
export { getAgentRouting, shouldSkipClassification } from "./agent-router.js";
export { KIMCHI_AGENT_NAME } from "./kimchi-agent.js";
export type { ProfileID, AgentProfile } from "./profiles.js";
export type { ModelTier, KimchiModel } from "./model-registry.js";
export type { ConversationPhase, PhaseDetectionResult } from "./phase-detector.js";
export type { TelemetryConfig, TelemetryClient, Telemetry, TelemetryPluginOption } from "./telemetry.js";
