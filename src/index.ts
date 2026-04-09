import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import type { ProfileID } from "./profiles.js";
import { resolveProfiles, type AgentProfile } from "./profiles.js";
import { classifyWithHeuristics } from "./heuristic-classifier.js";
import { extractSignals, detectPhase } from "./phase-detector.js";
import {
  getSession,
  setOverride,
  consumeOneShotOverride,
  consumeNextProfileSuggestion,
  updateSignals,
  recordDecision,
  setActiveProfile,
} from "./session-state.js";
import { routingTools } from "./tools.js";
import { buildTelemetryConfig, createTelemetry } from "./telemetry.js";

const KIMCHI_PROVIDER = "kimchi";

/**
 * Extract user text from message parts.
 * Defensively handles missing/malformed parts.
 */
function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is { type: "text"; text: string } =>
      p != null && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Safely get the provider ID from various input shapes.
 * Different hooks provide the model/provider info in different ways.
 */
function getProviderID(input: Record<string, any>): string | undefined {
  // chat.message: input.model?.providerID
  if (input.model?.providerID) return input.model.providerID;
  // chat.params / chat.headers: input.provider?.info?.id or input.model?.providerID
  if (input.provider?.info?.id) return input.provider.info.id;
  // system.transform: input.model?.providerID
  return undefined;
}

/**
 * Safely get the model ID from input.
 */
function getModelID(input: Record<string, any>): string | undefined {
  return input.model?.id ?? input.model?.modelID;
}

/**
 * Safely get the session ID from input.
 */
function getSessionID(input: Record<string, any>): string | undefined {
  return input.sessionID ?? undefined;
}

/**
 * Parse slash command overrides from user message.
 *
 * Commands:
 *   /plan       -> planner (one-shot)
 *   /code       -> coder (one-shot)
 *   /quick      -> assistant (one-shot)
 *   /debug      -> debugger (one-shot)
 *   /review     -> reviewer (one-shot)
 *   /explore    -> explorer (one-shot)
 *   /refactor   -> refactorer (one-shot)
 *   /lock <mode> -> sticky override until /auto
 *   /auto       -> clear override, resume auto-detection
 *   /profile    -> show current routing state
 */
function parseCommand(text: string): { profile: ProfileID; sticky: boolean } | "auto" | "profile" | null {
  const trimmed = text.trimStart();

  if (/^\/auto\b/i.test(trimmed)) return "auto";
  if (/^\/profile\b/i.test(trimmed)) return "profile";

  // One-shot mode commands
  if (/^\/plan\b/i.test(trimmed)) return { profile: "planner", sticky: false };
  if (/^\/code\b/i.test(trimmed)) return { profile: "coder", sticky: false };
  if (/^\/quick\b/i.test(trimmed)) return { profile: "assistant", sticky: false };
  if (/^\/debug\b/i.test(trimmed)) return { profile: "debugger", sticky: false };
  if (/^\/review\b/i.test(trimmed)) return { profile: "reviewer", sticky: false };
  if (/^\/explore\b/i.test(trimmed)) return { profile: "explorer", sticky: false };
  if (/^\/refactor\b/i.test(trimmed)) return { profile: "refactorer", sticky: false };

  // Sticky lock
  const lockMatch = trimmed.match(
    /^\/lock\s+(plan|code|quick|debug|review|explore|refactor|planner|coder|assistant|debugger|reviewer|explorer|refactorer|reasoning|coding)\b/i,
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
      explore: "explorer",
      explorer: "explorer",
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

const plugin: Plugin = async (ctx, options) => {
  const providerID = (options?.provider as string) ?? KIMCHI_PROVIDER;
  const verbose = (options?.verbose as boolean) ?? false;
  const profiles = resolveProfiles({
    models: options?.models as Partial<Record<ProfileID, string>> | undefined,
  });

  const telemetryConfig = buildTelemetryConfig(options?.telemetry as boolean | undefined);
  const telemetry = createTelemetry(telemetryConfig, ctx.client as any);

  return {
    tool: routingTools,

    /**
     * Forward session lifecycle and message events to the telemetry module.
     */
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      await telemetry.handleEvent(event);
    },

    /**
     * Track tool executions for productivity metrics (commits, PRs, LOC, edits).
     */
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: any },
      output: { title: string; output: string; metadata: any },
    ) => {
      await telemetry.handleToolAfter(
        { tool: input.tool, args: input.args ?? {} },
        { result: output.output },
      );
    },

    /**
     * Read conversation history and extract structural signals.
     * This feeds the phase detector with context about what's been happening.
     */
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
        log(verbose, `signals: tools=${signals.recentToolCalls}, edits=${signals.recentEditToolCalls}, reads=${signals.recentReadToolCalls}, errors=${signals.errorMentions}, msgs=${signals.totalMessages}`);
      } catch (err) {
        log(verbose, `messages.transform error: ${err}`);
      }
    },

    /**
     * Route user messages to the appropriate Kimchi model and profile.
     *
     * Priority order:
     * 1. Slash command overrides (/plan, /code, /debug, /review, etc.)
     * 2. LLM self-routing suggestion from previous turn
     * 3. Conversation phase detection (uses signals from messages.transform)
     * 4. Heuristic classifier (first message fallback)
     */
    "chat.message": async (input, output) => {
      try {
        // Only route when the current model is from the kimchi provider
        const inputProviderID = getProviderID(input as any);
        if (inputProviderID && inputProviderID !== providerID) {
          return;
        }

        const text = extractText(output?.parts);
        const sessionID = getSessionID(input as any);
        if (!sessionID) return;

        // --- Layer 1: Slash commands ---
        const command = parseCommand(text);
        if (command === "auto") {
          setOverride(sessionID, null);
          log(verbose, "Auto mode selection resumed.");
        } else if (command === "profile") {
          const session = getSession(sessionID);
          const lastDecision = session.history[session.history.length - 1];
          log(verbose, `State: active=${session.activeProfile ?? "auto"}, override=${session.override?.profile ?? "none"}, lastDecision=${lastDecision?.source ?? "none"}`);
        } else if (command) {
          setOverride(sessionID, command);
        }

        // --- Determine the profile ---
        //
        // Mode stickiness: once a mode is established, stay in it unless:
        //   - User explicitly switches (slash command, /auto)
        //   - LLM suggests a switch via self-routing tools
        //   - A new detection has high confidence (>= 0.7) for a DIFFERENT mode
        //
        // This prevents vague follow-ups like "what about the auth module?"
        // from bouncing you out of debug mode.
        //
        const STICKY_THRESHOLD = 0.7;

        let profile: AgentProfile;
        let source: string;

        const override = consumeOneShotOverride(sessionID);
        if (override) {
          profile = profiles[override.profile];
          source = override.sticky ? `locked: ${override.profile}` : `override: ${override.profile}`;
        } else {
          const suggestion = consumeNextProfileSuggestion(sessionID);
          if (suggestion) {
            profile = profiles[suggestion];
            source = `llm-suggestion: ${suggestion}`;
          } else {
            const session = getSession(sessionID);
            let detected: { profile: ProfileID; confidence: number; source: string };

            if (session.signals && session.signals.totalMessages >= 3) {
              const result = detectPhase(session.signals, text);
              detected = { profile: result.profile, confidence: result.confidence, source: result.reason };
            } else {
              const result = classifyWithHeuristics(text);
              detected = { profile: result.profile, confidence: result.confidence, source: result.reason };
            }

            // Apply stickiness: keep current mode unless detection is confident about a different one
            const currentProfile = session.activeProfile;
            if (currentProfile && detected.profile !== currentProfile && detected.confidence < STICKY_THRESHOLD) {
              profile = profiles[currentProfile];
              source = `sticky: ${currentProfile} (detected ${detected.profile} at ${(detected.confidence * 100).toFixed(0)}%, below threshold)`;
            } else {
              profile = profiles[detected.profile];
              source = detected.source;
            }
          }
        }

        // Apply the routing decision
        if (output?.message) {
          output.message.model = {
            providerID,
            modelID: profile.model,
          };
        }

        // Store the active profile so the system prompt hook knows which personality to inject
        setActiveProfile(sessionID, profile.id);
        recordDecision(sessionID, { profile: profile.id, source });
        log(verbose, `-> ${profile.label} | ${source}`);
      } catch (err) {
        log(verbose, `chat.message error: ${err}`);
      }
    },

    /**
     * Inject profile-specific system prompts.
     *
     * Since multiple profiles share the same model (e.g. planner/debugger/reviewer
     * all use kimi-k2.5), we use the active profile from session state rather
     * than looking up by model ID.
     */
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const inputProviderID = (input as any)?.model?.providerID;
        if (inputProviderID && inputProviderID !== providerID) return;

        // Use active profile from session state if available
        const sessionID = getSessionID(input as any);
        if (sessionID) {
          const session = getSession(sessionID);
          if (session.activeProfile) {
            output.system.push(profiles[session.activeProfile].systemPrompt);
            return;
          }
        }

        // Fallback: match by model ID (first matching profile)
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

    /**
     * Set temperature per active profile.
     */
    "chat.params": async (input, output) => {
      try {
        // Check provider from any available source
        const inputProviderID = getProviderID(input as any);
        if (inputProviderID && inputProviderID !== providerID) return;

        // Use active profile from session state
        const sessionID = getSessionID(input as any);
        if (sessionID) {
          const session = getSession(sessionID);
          if (session.activeProfile) {
            output.temperature = profiles[session.activeProfile].temperature;
            return;
          }
        }

        // Fallback: match by model ID
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
  };
};

const pluginModule: PluginModule = {
  id: "opencode-kimchi",
  server: plugin,
};

export default pluginModule;
export { plugin, resolveProfiles };
export { classifyWithHeuristics } from "./heuristic-classifier.js";
export { detectPhase, extractSignals } from "./phase-detector.js";
export { routingTools } from "./tools.js";
export { buildTelemetryConfig, createTelemetry } from "./telemetry.js";
export type { ProfileID, AgentProfile } from "./profiles.js";
export type { ConversationPhase, PhaseDetectionResult } from "./phase-detector.js";
export type { TelemetryConfig, TelemetryClient, Telemetry } from "./telemetry.js";
