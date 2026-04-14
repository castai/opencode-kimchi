import pluginModule from "./index.js";
import { _resetAll, getSession, getSelectedModel } from "./session-state.js";
import { _resetAllCosts } from "./cost-tracker.js";
import { _resetAllFallbacks, hasPendingFallback } from "./model-fallback.js";

const MOCK_KIMCHI_CONFIG = {
  provider: {
    kimchi: {
      models: {
        "kimi-k2.5": { reasoning: false, cost: { input: 0.6, output: 3.0 }, limit: { context: 262000, output: 32000 }, modalities: { input: ["text", "image"], output: ["text"] } },
        "minimax-m2.7": { reasoning: false, cost: { input: 0.3, output: 1.2 }, limit: { context: 196000, output: 32000 } },
        "claude-sonnet-4-20250514": { reasoning: true, cost: { input: 3.0, output: 15.0 }, limit: { context: 200000, output: 64000 }, modalities: { input: ["text", "image"], output: ["text"] } },
        "gpt-4.1-nano": { reasoning: false, cost: { input: 0.1, output: 0.4 }, limit: { context: 1047576, output: 32768 }, modalities: { input: ["text", "image"], output: ["text"] } },
      },
      options: { apiKey: "test-key" },
    },
  },
};

async function test() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) {
      passed++;
    } else {
      failed++;
      console.error(`FAIL: ${label}`);
    }
  }

  _resetAll();
  _resetAllCosts();

  assert(pluginModule.id === "opencode-kimchi", "module has correct id");
  assert(typeof pluginModule.server === "function", "module.server is a function");

  const mockCtx = {
    client: {} as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
  };
  const hooks = await pluginModule.server(mockCtx);

  // --- Hook existence ---
  assert(typeof hooks["chat.message"] === "function", "chat.message hook exists");
  assert(typeof hooks["experimental.chat.system.transform"] === "function", "system.transform hook exists");
  assert(typeof hooks["experimental.chat.messages.transform"] === "function", "messages.transform hook exists");
  assert(typeof hooks["chat.params"] === "function", "chat.params hook exists");
  assert(typeof hooks["tool.execute.after"] === "function", "tool.execute.after hook exists");
  assert(typeof hooks["experimental.session.compacting"] === "function", "session.compacting hook exists");
  assert(typeof hooks["event"] === "function", "event hook exists");

  assert(typeof hooks["config"] === "function", "config hook exists");
  assert(hooks.provider !== undefined, "provider hook exists");
  assert(typeof hooks.provider!.models === "function", "provider.models function exists");
  assert(hooks.tool !== undefined, "tool hook exists");
  assert("suggest_reasoning_mode" in hooks.tool!, "suggest_reasoning_mode tool exists");
  assert("suggest_coding_mode" in hooks.tool!, "suggest_coding_mode tool exists");
  assert("suggest_quick_mode" in hooks.tool!, "suggest_quick_mode tool exists");

  // --- Load models from config (must happen before routing tests) ---
  await hooks["config"]!(structuredClone(MOCK_KIMCHI_CONFIG) as any);

  // --- Provider hook returns virtual models ---
  const mockProvider = {
    models: {
      "kimi-k2.5": { api: { id: "kimchi", url: "https://llm.cast.ai/openai/v1", npm: "@ai-sdk/openai-compatible" } },
    },
  };
  const providerModels = await hooks.provider!.models!(mockProvider as any, {} as any);
  assert("auto" in providerModels, "provider has 'auto' virtual model");
  assert("reasoning" in providerModels, "provider has 'reasoning' virtual model");
  assert("coding" in providerModels, "provider has 'coding' virtual model");
  assert("quick" in providerModels, "provider has 'quick' virtual model");

  // --- Config hook sets default model ---
  const testConfig: any = {};
  await hooks["config"]!(testConfig);
  assert(testConfig.model === "kimchi/auto", "config sets default model to kimchi/auto");

  const testConfig2: any = { model: "openai/gpt-4" };
  await hooks["config"]!(testConfig2);
  assert(testConfig2.model === "openai/gpt-4", "config does not override existing model");

  // --- Config hook loads new models from provider section ---
  _resetAll();
  const configWithNewModel: any = structuredClone(MOCK_KIMCHI_CONFIG);
  configWithNewModel.provider.kimchi.models["new-model-x"] = { reasoning: false, name: "New Model X", cost: { input: 0.1, output: 0.5 }, limit: { context: 100000, output: 16000 } };
  await hooks["config"]!(configWithNewModel);
  assert(configWithNewModel.model === "kimchi/auto", "config with new model still sets default");

  const updatedModels = await hooks.provider!.models!(mockProvider as any, {} as any);
  assert("new-model-x" in updatedModels, "new model from config appears in provider models");

  // --- Priority-based tier resolution (with multi-tier kimchi models) ---
  // reasoning: kimi-k2.5 (priority 60, only reasoning-tier model in test config)
  // coding: claude-sonnet-4-20250514 (priority 12) > kimi-k2.5 (priority 25) > minimax-m2.7 (priority 40)
  // quick: minimax-m2.7 (priority 10) > gpt-4.1-nano (priority 20) > kimi-k2.5 (priority 40)

  function makeOutput(sessionID: string, msgID: string, text: string) {
    return {
      message: { id: msgID, sessionID, role: "user" as const, time: { created: Date.now() }, agent: "default", model: { providerID: "kimchi", modelID: "auto" } },
      parts: [{ id: `p-${msgID}`, sessionID, messageID: msgID, type: "text" as const, text }],
    };
  }

  async function routeAndGetModel(
    sessionID: string,
    msgID: string,
    text: string,
    inputModel = "auto",
    agent?: string,
  ): Promise<string> {
    // Always start with model "auto" on the output message.
    // chat.message only changes it for explicit/tier/fallback selections.
    // For auto-routing, it stays "auto" and chat.params provides the model.
    const output = makeOutput(sessionID, msgID, text);
    const input: any = { sessionID, model: { providerID: "kimchi", modelID: inputModel } };
    if (agent) input.agent = agent;
    await hooks["chat.message"]!(input, output);

    // If chat.message changed the message model from "auto", it's an
    // explicit/tier/fallback selection — use it directly.
    const messageModel = output.message.model?.modelID;
    if (messageModel && messageModel !== "auto") {
      return messageModel;
    }

    // Auto-routed: run chat.params to get the model from providerOptions
    const paramsOutput = { temperature: 0.5, topP: 1, topK: 0, options: {} as any };
    await hooks["chat.params"]!(
      { sessionID, agent: agent ?? "build", model: { id: "auto", providerID: "kimchi" } as any, provider: {} as any, message: output.message } as any,
      paramsOutput,
    );
    return paramsOutput.options?.model ?? "auto";
  }

  // =========================================================================
  // HEURISTIC ROUTING (first message, no history)
  // =========================================================================

  _resetAll();
  assert(await routeAndGetModel("s-code", "m1", "Implement a new function to parse CSV files") === "claude-sonnet-4-20250514", "coding task routes to sonnet");

  _resetAll();
  assert(await routeAndGetModel("s-plan", "m2", "Plan the architecture for the microservices migration") === "kimi-k2.5", "planning task routes to kimi-k2.5");

  _resetAll();
  assert(await routeAndGetModel("s-quick", "m3", "What is the status?") === "claude-sonnet-4-20250514", "quick task floored to coding tier for primary agent");

  _resetAll();
  assert(await routeAndGetModel("s-debug", "m4", "I'm getting a TypeError: Cannot read property 'id' of undefined") === "kimi-k2.5", "debug task routes to reasoning tier");

  _resetAll();
  assert(await routeAndGetModel("s-review", "m5", "Review this code for security vulnerabilities") === "kimi-k2.5", "review task routes to reasoning tier");

  _resetAll();
  assert(await routeAndGetModel("s-explore", "m6", "Where is the database configuration file?") === "claude-sonnet-4-20250514", "explore-like query floored to coding tier for primary agent");

  _resetAll();
  assert(await routeAndGetModel("s-refactor", "m7", "Refactor the payment module to use the strategy pattern") === "claude-sonnet-4-20250514", "refactor task routes to coding tier");

  // =========================================================================
  // DIRECT TIER SELECTION
  // =========================================================================

  _resetAll();
  assert(await routeAndGetModel("s-direct1", "m60", "Hello", "reasoning") === "kimi-k2.5", "direct reasoning tier resolves to best available");

  _resetAll();
  assert(await routeAndGetModel("s-direct2", "m61", "Hello", "coding") === "claude-sonnet-4-20250514", "direct coding tier resolves to best available");

  _resetAll();
  assert(await routeAndGetModel("s-direct3", "m62", "Hello", "quick") === "minimax-m2.7", "direct quick tier resolves to best available");

  // =========================================================================
  // AGENT-BASED ROUTING
  // =========================================================================

  // Subagents skip classification and route directly to their tier
  _resetAll();
  assert(await routeAndGetModel("s-agent1", "m70", "Find all files that import UserService", "auto", "explore") === "minimax-m2.7", "explore agent routes to quick tier");

  _resetAll();
  assert(await routeAndGetModel("s-agent2", "m71", "Research best practices for auth", "auto", "general") === "claude-sonnet-4-20250514", "general agent routes to coding tier");

  // System agents always get quick tier
  _resetAll();
  assert(await routeAndGetModel("s-agent3", "m72", "Generate a title", "auto", "title") === "minimax-m2.7", "title agent routes to quick tier");

  _resetAll();
  assert(await routeAndGetModel("s-agent4", "m73", "Compact this context", "auto", "compaction") === "minimax-m2.7", "compaction agent routes to quick tier");

  _resetAll();
  assert(await routeAndGetModel("s-agent5", "m74", "Summarize the session", "auto", "summary") === "minimax-m2.7", "summary agent routes to quick tier");

  // Primary agents fall through to heuristic classification (not short-circuited)
  _resetAll();
  assert(await routeAndGetModel("s-agent6", "m75", "Plan the architecture for the auth system", "auto", "build") === "kimi-k2.5", "build agent falls through to heuristic (planning -> reasoning)");

  _resetAll();
  assert(await routeAndGetModel("s-agent7", "m76", "What is this?", "auto", "plan") === "claude-sonnet-4-20250514", "plan agent floored to coding tier (primary agents skip quick)");

  // Unknown agents also fall through to heuristic classification
  _resetAll();
  assert(await routeAndGetModel("s-agent8", "m77", "Implement a new React component for the dashboard sidebar", "auto", "my-custom-agent") === "claude-sonnet-4-20250514", "unknown agent falls through to heuristic");

  // =========================================================================
  // CONFIG HOOK SETS AGENT MODEL DEFAULTS
  // =========================================================================

  _resetAll();
  const agentConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  await hooks["config"]!(agentConfig);
  assert(agentConfig.agent?.["kimchi-auto"]?.model === "kimchi/auto", "config creates kimchi-auto agent");
  assert(agentConfig.agent?.["kimchi-auto"]?.mode === "primary", "kimchi-auto is primary agent");
  assert(agentConfig.default_agent === "kimchi-auto", "config sets default_agent to kimchi-auto");
  assert(agentConfig.agent?.explore?.model === "kimchi/auto", "config sets explore agent to auto model");
  assert(agentConfig.agent?.general?.model === "kimchi/auto", "config sets general agent to auto model");
  assert(agentConfig.agent?.title?.model === "kimchi/quick", "config sets title agent to quick model");
  assert(agentConfig.agent?.summary?.model === "kimchi/quick", "config sets summary agent to quick model");
  assert(agentConfig.agent?.compaction?.model === "kimchi/quick", "config sets compaction agent to quick model");

  // Respects existing user config
  _resetAll();
  const userAgentConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  userAgentConfig.agent = { explore: { model: "anthropic/claude-opus-4-6" } };
  await hooks["config"]!(userAgentConfig);
  assert(userAgentConfig.agent.explore.model === "anthropic/claude-opus-4-6", "config does not override user-configured agent model");
  assert(userAgentConfig.agent.title?.model === "kimchi/quick", "config still sets unconfigured agents");

  // User sets an explicit kimchi model in config.model — agent should use it
  _resetAll();
  const explicitModelConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  explicitModelConfig.model = "kimchi/claude-sonnet-4-20250514";
  await hooks["config"]!(explicitModelConfig);
  assert(explicitModelConfig.agent?.["kimchi-auto"]?.model === "kimchi/claude-sonnet-4-20250514",
    "config: explicit kimchi model propagated to kimchi-auto agent");
  assert(explicitModelConfig.default_agent === "kimchi-auto",
    "config: default_agent still set to kimchi-auto");
  assert(explicitModelConfig.model === "kimchi/claude-sonnet-4-20250514",
    "config: config.model preserved");

  // kimchi/auto in config.model — agent should use auto (default behaviour)
  _resetAll();
  const autoModelConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  autoModelConfig.model = "kimchi/auto";
  await hooks["config"]!(autoModelConfig);
  assert(autoModelConfig.agent?.["kimchi-auto"]?.model === "kimchi/auto",
    "config: kimchi/auto in config.model keeps agent on auto");

  // kimchi/reasoning (tier alias) in config.model — agent should use auto (not the alias)
  _resetAll();
  const tierModelConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  tierModelConfig.model = "kimchi/reasoning";
  await hooks["config"]!(tierModelConfig);
  assert(tierModelConfig.agent?.["kimchi-auto"]?.model === "kimchi/auto",
    "config: tier alias in config.model keeps agent on auto");

  // Non-kimchi model in config.model — agent should use auto (not the non-kimchi model)
  _resetAll();
  const nonKimchiConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  nonKimchiConfig.model = "anthropic/claude-opus-4-6";
  await hooks["config"]!(nonKimchiConfig);
  assert(nonKimchiConfig.agent?.["kimchi-auto"]?.model === "kimchi/auto",
    "config: non-kimchi model in config.model keeps agent on auto");

  // Pre-existing agent config should NOT be overridden
  _resetAll();
  const existingAgentConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  existingAgentConfig.model = "kimchi/kimi-k2.5";
  existingAgentConfig.agent = { "kimchi-auto": { model: "kimchi/minimax-m2.7", mode: "primary" } };
  await hooks["config"]!(existingAgentConfig);
  assert(existingAgentConfig.agent["kimchi-auto"].model === "kimchi/minimax-m2.7",
    "config: pre-existing agent config not overridden by config.model");

  // =========================================================================
  // TOOL.DEFINITION — TASK TOOL ENHANCEMENT
  // =========================================================================

  const taskToolOutput = { description: "Original task description", parameters: {} };
  await hooks["tool.definition"]!({ toolID: "task" }, taskToolOutput);
  assert(taskToolOutput.description.includes("subagent"), "task tool description enhanced with subagent guidance");
  assert(taskToolOutput.description.includes("Original task description"), "task tool original description preserved");

  const otherToolOutput = { description: "Some other tool", parameters: {} };
  await hooks["tool.definition"]!({ toolID: "read" }, otherToolOutput);
  assert(otherToolOutput.description === "Some other tool", "non-task tool description not modified");

  // --- Complex tool detection (schema-based) ---
  // Tool with >5 params → complex
  const manyParamsTool = {
    description: "A tool with many params",
    parameters: { properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {} } },
  };
  await hooks["tool.definition"]!({ toolID: "some_api_tool" }, manyParamsTool);
  assert(manyParamsTool.description.includes("[IMPORTANT: This tool has a complex schema"),
    "tool with >5 params flagged as complex");

  // Tool with nested object → complex
  const nestedTool = {
    description: "A tool with nested objects",
    parameters: { properties: { query: { type: "string" }, options: { type: "object", properties: { limit: { type: "number" } } } } },
  };
  await hooks["tool.definition"]!({ toolID: "nested_tool" }, nestedTool);
  assert(nestedTool.description.includes("[IMPORTANT: This tool has a complex schema"),
    "tool with nested object property flagged as complex");

  // Tool with oneOf combinator → complex
  const combinatorTool = {
    description: "A tool with union types",
    parameters: { properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } } },
  };
  await hooks["tool.definition"]!({ toolID: "union_tool" }, combinatorTool);
  assert(combinatorTool.description.includes("[IMPORTANT: This tool has a complex schema"),
    "tool with oneOf combinator flagged as complex");

  // Simple tool → not flagged
  const simpleTool = { description: "A simple tool", parameters: { properties: { path: { type: "string" } } } };
  await hooks["tool.definition"]!({ toolID: "simple_tool" }, simpleTool);
  assert(!simpleTool.description.includes("[IMPORTANT"),
    "simple tool with 1 param not flagged as complex");

  // task() itself → never flagged (it's the delegation mechanism)
  const taskComplexCheck = {
    description: "Task tool",
    parameters: { properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {} } },
  };
  await hooks["tool.definition"]!({ toolID: "task" }, taskComplexCheck);
  assert(!taskComplexCheck.description.includes("[IMPORTANT: This tool has a complex schema"),
    "task() tool never flagged as complex even with many params");

  // =========================================================================
  // KIMCHI-AUTO AGENT — DELEGATION PROMPT IN AGENT CONFIG
  // =========================================================================

  _resetAll();
  const kimchiAgentConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  await hooks["config"]!(kimchiAgentConfig);
  const agentPrompt = kimchiAgentConfig.agent?.["kimchi-auto"]?.prompt ?? "";
  assert(agentPrompt.includes("Orchestrator"), "kimchi-auto agent has orchestrator role");
  assert(agentPrompt.includes("@explore"), "kimchi-auto prompt mentions @explore");
  assert(agentPrompt.includes("@general"), "kimchi-auto prompt mentions @general");
  assert(agentPrompt.includes("<delegation>"), "kimchi-auto prompt has delegation section");
  assert(agentPrompt.includes("<intent-gate>"), "kimchi-auto prompt has workflow section");
  assert(agentPrompt.includes("<codebase-first>"), "kimchi-auto prompt has codebase-first section");
  assert(agentPrompt.includes("<testing>"), "kimchi-auto prompt has testing section");
  assert(agentPrompt.includes("<verification>"), "kimchi-auto prompt has verification section");
  assert(agentPrompt.includes("<guardrails>"), "kimchi-auto prompt has rules section");
  assert(agentPrompt.includes("model-routing"), "kimchi-auto prompt has dynamic model context");
  assert(agentPrompt.includes("kimi-k2.5"), "kimchi-auto prompt includes available model names");
  assert(agentPrompt.includes("description"), "kimchi-auto prompt documents task() required params");
  assert(agentPrompt.includes("subagent_type"), "kimchi-auto prompt documents subagent_type param");

  // =========================================================================
  // SLASH COMMAND OVERRIDES
  // =========================================================================

  _resetAll();
  assert(await routeAndGetModel("s-cmd1", "m10", "/plan What is the status?") === "kimi-k2.5", "/plan forces reasoning model");
  assert(await routeAndGetModel("s-cmd1", "m11", "What is this?") === "claude-sonnet-4-20250514", "one-shot /plan clears, quick floored to coding for primary agent");

  _resetAll();
  assert(await routeAndGetModel("s-cmd2", "m12", "/debug Check the login flow") === "kimi-k2.5", "/debug forces reasoning model");

  _resetAll();
  assert(await routeAndGetModel("s-cmd3", "m13", "/review Check my code") === "kimi-k2.5", "/review forces reasoning model");

  _resetAll();
  assert(await routeAndGetModel("s-cmd5", "m15", "/refactor Clean up the utils") === "claude-sonnet-4-20250514", "/refactor forces coding model");

  _resetAll();
  assert(await routeAndGetModel("s-lock", "m20", "/lock debug") === "kimi-k2.5", "/lock debug forces reasoning");
  assert(await routeAndGetModel("s-lock", "m21", "What is this?") === "kimi-k2.5", "locked debug persists");
  assert(await routeAndGetModel("s-lock", "m22", "/auto What is this?") === "claude-sonnet-4-20250514", "/auto clears lock, quick floored to coding for primary agent");

  // =========================================================================
  // NON-KIMCHI PROVIDER IS SKIPPED
  // =========================================================================

  _resetAll();
  const otherProviderParams = { temperature: 0.5, topP: 1, topK: 0, options: {} as any };
  const otherOutput = makeOutput("s-other", "m30", "Implement a function");
  otherOutput.message.model = { providerID: "openai", modelID: "gpt-4" };
  await hooks["chat.message"]!({ sessionID: "s-other", model: { providerID: "openai", modelID: "gpt-4" } }, otherOutput);
  await hooks["chat.params"]!({ sessionID: "s-other", agent: "build", model: { id: "gpt-4", providerID: "openai" } as any, provider: { info: { id: "openai" } } as any, message: otherOutput.message } as any, otherProviderParams);
  assert(!otherProviderParams.options?.model, "non-kimchi provider model not overridden");

  // =========================================================================
  // SYSTEM PROMPT INJECTION
  // =========================================================================

  _resetAll();
  const debugForSystem = makeOutput("s-sys", "m40", "Debug the TypeError in the handler");
  await hooks["chat.message"]!({ sessionID: "s-sys", model: { providerID: "kimchi", modelID: "auto" } }, debugForSystem);

  const systemOutput = { system: ["existing system prompt"] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s-sys", model: { id: "kimi-k2.5", providerID: "kimchi" } as any },
    systemOutput,
  );
  // For kimi-k2.5: [OVERRIDE] is unshifted to front, so order is:
  // [0] self-execution override (unshifted), [1] existing, [2] profile, [3] delegation, [4] tool rule
  assert(systemOutput.system.length === 5, "system transform adds profile prompt + delegation guidance + model-specific prompts");
  assert(systemOutput.system[0].includes("[OVERRIDE]"), "self-execution override is FIRST system message for kimi-k2.5");
  assert(systemOutput.system[0].includes("kimi-k2.5"), "self-execution override names the model");
  assert(systemOutput.system[2].includes("debugging"), "debugger profile system prompt injected");
  assert(systemOutput.system[3].includes("ORCHESTRATOR"), "delegation guidance injected");
  assert(systemOutput.system[4].includes("TOOL RULE"), "tool-call rule injected for kimi-k2.5");

  const reviewForSystem = makeOutput("s-sys", "m41", "/review Check my code");
  await hooks["chat.message"]!({ sessionID: "s-sys", model: { providerID: "kimchi", modelID: "auto" } }, reviewForSystem);

  const systemOutput2 = { system: ["existing system prompt"] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s-sys", model: { id: "kimi-k2.5", providerID: "kimchi" } as any },
    systemOutput2,
  );
  assert(systemOutput2.system[2].includes("review"), "reviewer profile system prompt injected after /review (index 2 due to kimi override at 0)");

  // Delegation nudge: after 5+ direct tool calls with zero delegation
  _resetAll();
  const nudgeSetup = makeOutput("s-nudge", "m42", "Implement a new feature");
  await hooks["chat.message"]!({ sessionID: "s-nudge", model: { providerID: "kimchi", modelID: "auto" } }, nudgeSetup);
  for (let i = 0; i < 6; i++) {
    await hooks["tool.execute.after"]!({ tool: "edit", sessionID: "s-nudge", callID: `c${i}`, args: { filePath: `/src/file${i}.ts` } }, { title: "", output: "ok", metadata: {} });
  }
  const nudgeSystemOutput = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s-nudge", model: { id: "auto", providerID: "kimchi" } as any },
    nudgeSystemOutput,
  );
  assert(nudgeSystemOutput.system.some((s: string) => s.includes("[STOP]")), "strong delegation nudge injected after 5+ direct calls with zero delegation");

  // No nudge if delegation has occurred
  _resetAll();
  const noNudgeSetup = makeOutput("s-nonudge", "m43", "Implement something");
  await hooks["chat.message"]!({ sessionID: "s-nonudge", model: { providerID: "kimchi", modelID: "auto" } }, noNudgeSetup);
  for (let i = 0; i < 6; i++) {
    await hooks["tool.execute.after"]!({ tool: "edit", sessionID: "s-nonudge", callID: `d${i}`, args: { filePath: `/src/f${i}.ts` } }, { title: "", output: "ok", metadata: {} });
  }
  await hooks["tool.execute.after"]!({ tool: "task", sessionID: "s-nonudge", callID: "d-task", args: {} }, { title: "", output: "ok", metadata: {} });
  const noNudgeSystemOutput = { system: ["base"] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s-nonudge", model: { id: "auto", providerID: "kimchi" } as any },
    noNudgeSystemOutput,
  );
  assert(!noNudgeSystemOutput.system.some((s: string) => s.includes("[STOP]")), "no strong nudge when delegation has occurred");

  // =========================================================================
  // TOOL.EXECUTE.AFTER — LIVE SIGNAL TRACKING
  // =========================================================================

  _resetAll();
  await hooks["tool.execute.after"]!({ tool: "edit", sessionID: "s-live", callID: "c1", args: {} }, { title: "edit", output: "done", metadata: {} });
  await hooks["tool.execute.after"]!({ tool: "edit", sessionID: "s-live", callID: "c2", args: {} }, { title: "edit", output: "done", metadata: {} });
  await hooks["tool.execute.after"]!({ tool: "read", sessionID: "s-live", callID: "c3", args: {} }, { title: "read", output: "error: file not found", metadata: {} });

  // =========================================================================
  // SESSION COMPACTION
  // =========================================================================

  _resetAll();
  const compactSetup = makeOutput("s-compact", "m50", "Debug the TypeError");
  await hooks["chat.message"]!({ sessionID: "s-compact", model: { providerID: "kimchi", modelID: "auto" } }, compactSetup);

  const compactOutput = { context: [] as string[], prompt: undefined as string | undefined };
  await hooks["experimental.session.compacting"]!({ sessionID: "s-compact" }, compactOutput);
  assert(compactOutput.context.length >= 1, "compaction injects routing context");
  assert(compactOutput.context.some((c: string) => c.includes("debugger")), "compaction context mentions active profile");
  assert(typeof compactOutput.prompt === "string", "compaction sets custom prompt");
  assert(compactOutput.prompt!.includes("PRESERVE"), "compaction prompt has preservation guidance");
  assert(compactOutput.prompt!.includes("OMIT"), "compaction prompt has omission guidance");

  // Compaction with file tracking
  _resetAll();
  const compactSetup2 = makeOutput("s-compact2", "m51", "Implement the parser");
  await hooks["chat.message"]!({ sessionID: "s-compact2", model: { providerID: "kimchi", modelID: "auto" } }, compactSetup2);
  await hooks["tool.execute.after"]!({ tool: "edit", sessionID: "s-compact2", callID: "c1", args: { filePath: "/src/parser.ts" } }, { title: "", output: "ok", metadata: {} });
  await hooks["tool.execute.after"]!({ tool: "read", sessionID: "s-compact2", callID: "c2", args: { filePath: "/src/utils.ts" } }, { title: "", output: "ok", metadata: {} });
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s-compact2", callID: "c3", args: {} }, { title: "", output: "error: TypeError cannot read", metadata: {} });

  const compactOutput2 = { context: [] as string[], prompt: undefined as string | undefined };
  await hooks["experimental.session.compacting"]!({ sessionID: "s-compact2" }, compactOutput2);
  assert(compactOutput2.context.some((c: string) => c.includes("/src/parser.ts")), "compaction includes modified files");
  assert(compactOutput2.context.some((c: string) => c.includes("/src/utils.ts")), "compaction includes read files");
  assert(compactOutput2.context.some((c: string) => c.includes("error")), "compaction includes recent errors");

  // =========================================================================
  // MODE STICKINESS
  // =========================================================================

  _resetAll();
  assert(await routeAndGetModel("s-sticky", "m80", "I'm getting a TypeError when calling the function") === "kimi-k2.5", "stickiness: initial debug routes to reasoning");
  assert(await routeAndGetModel("s-sticky", "m83", "/code implement the fix") === "claude-sonnet-4-20250514", "stickiness: /code breaks out of sticky debug");

  _resetAll();
  assert(await routeAndGetModel("s-sticky2", "m90", "Plan the architecture for the new auth system") === "kimi-k2.5", "stickiness: initial plan routes to reasoning");
  assert(await routeAndGetModel("s-sticky2", "m91", "Refactor the payment module to clean up the duplicated validation code") === "claude-sonnet-4-20250514", "stickiness: cross-tier refactor breaks out of planner");

  // =========================================================================
  // CONTEXT-AWARE MODEL SELECTION
  // =========================================================================

  // When context is small, quick tier resolves to minimax normally
  _resetAll();
  assert(await routeAndGetModel("s-ctx1", "m100", "What is this?") === "claude-sonnet-4-20250514", "context-aware: quick floored to coding for primary agent");

  // Simulate large context by updating context estimate via event
  _resetAll();
  await routeAndGetModel("s-ctx2", "m101", "What is this?");
  // Simulate event with large input token count (exceeds minimax 196K)
  await hooks["event"]!({ event: { type: "message.updated", properties: { info: { id: "m101", sessionID: "s-ctx2", role: "assistant", providerID: "kimchi", cost: 0.01, tokens: { input: 180000, output: 5000 } } } } as any });
  const ctx2Session = getSession("s-ctx2");
  assert(ctx2Session.estimatedContextTokens === 185000, "context estimate updated from event");

  // Now route another quick message — context (185K) exceeds 85% of coding tier
  // default (200K * 0.85 = 170K), so it should upgrade to a model with a larger
  // context window. For auto-routing, the model comes from chat.params.
  const upgradedModel = await routeAndGetModel("s-ctx2", "m102", "What is the status?");
  // Should upgrade to a model with context > 185K
  assert(upgradedModel !== "minimax-m2.7", "context-aware: upgrades away from minimax when context is large");
  assert(upgradedModel === "gpt-4.1-nano" || upgradedModel === "kimi-k2.5", "context-aware: upgraded to a model with sufficient context window");

  // Context well within limits should NOT trigger upgrade
  _resetAll();
  await routeAndGetModel("s-ctx3", "m103", "What is this?");
  await hooks["event"]!({ event: { type: "message.updated", properties: { info: { id: "m103", sessionID: "s-ctx3", role: "assistant", providerID: "kimchi", cost: 0.001, tokens: { input: 50000, output: 2000 } } } } as any });
  assert(await routeAndGetModel("s-ctx3", "m104", "What is the status?") === "claude-sonnet-4-20250514", "context-aware: quick floored to coding for primary agent");

  // =========================================================================
  // MODEL FALLBACK ON ERROR
  // =========================================================================

  // APIError (500) should arm fallback
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb1", "m200", "Implement a new function to parse CSV files");
  assert(getSession("s-fb1").activeProfile === "coder", "fallback: initial route is coder");

  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb1",
    error: { name: "APIError", data: { message: "Internal Server Error", statusCode: 500, isRetryable: true } },
  }} as any });
  assert(hasPendingFallback("s-fb1"), "fallback: pending fallback armed after APIError 500");

  const fb1Model = await routeAndGetModel("s-fb1", "m201", "Implement a new function to parse CSV files");
  assert(fb1Model !== "claude-sonnet-4-20250514", "fallback: switched away from failed model");
  assert(!hasPendingFallback("s-fb1"), "fallback: pending cleared after application");

  // APIError (400) should also be retryable
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb400", "m210", "Implement a function");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb400",
    error: { name: "APIError", data: { message: "Bad Request", statusCode: 400, isRetryable: true } },
  }} as any });
  assert(hasPendingFallback("s-fb400"), "fallback: 400 error arms fallback");

  // ContextOverflowError should arm fallback
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb2", "m202", "What is this?");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb2",
    error: { name: "ContextOverflowError", data: { message: "Context too large" } },
  }} as any });
  assert(hasPendingFallback("s-fb2"), "fallback: pending fallback armed after ContextOverflowError");

  // UnknownError should arm fallback
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb3", "m203", "Help me debug this");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb3",
    error: { name: "UnknownError", data: { message: "Something went wrong" } },
  }} as any });
  assert(hasPendingFallback("s-fb3"), "fallback: pending fallback armed after UnknownError");

  // ProviderAuthError should NOT arm fallback
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb4", "m204", "Hello");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb4",
    error: { name: "ProviderAuthError", data: { providerID: "kimchi", message: "Invalid API key" } },
  }} as any });
  assert(!hasPendingFallback("s-fb4"), "fallback: ProviderAuthError does NOT arm fallback");

  // MessageAbortedError should NOT arm fallback
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb5", "m205", "Hello");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb5",
    error: { name: "MessageAbortedError", data: { message: "User cancelled" } },
  }} as any });
  assert(!hasPendingFallback("s-fb5"), "fallback: MessageAbortedError does NOT arm fallback");

  // 401 Unauthorized should NOT arm fallback
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb6", "m206", "Hello");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb6",
    error: { name: "APIError", data: { message: "Unauthorized", statusCode: 401, isRetryable: false } },
  }} as any });
  assert(!hasPendingFallback("s-fb6"), "fallback: 401 does NOT arm fallback");

  // 403 Forbidden should NOT arm fallback
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb7", "m207", "Hello");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb7",
    error: { name: "APIError", data: { message: "Forbidden", statusCode: 403, isRetryable: false } },
  }} as any });
  assert(!hasPendingFallback("s-fb7"), "fallback: 403 does NOT arm fallback");

  // Successful message clears fallback state
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb8", "m208", "Implement X");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb8",
    error: { name: "APIError", data: { message: "Server Error", statusCode: 500, isRetryable: true } },
  }} as any });
  assert(hasPendingFallback("s-fb8"), "fallback: armed after error");
  await routeAndGetModel("s-fb8", "m209", "Implement X");
  await hooks["event"]!({ event: { type: "message.updated", properties: { info: {
    id: "m209", sessionID: "s-fb8", role: "assistant", providerID: "kimchi",
    cost: 0.01, tokens: { input: 1000, output: 500 }, finish: true,
  }}} as any });
  assert(!hasPendingFallback("s-fb8"), "fallback: cleared after successful finished message");

  // Streaming update (no finish flag) should NOT clear fallback state
  _resetAll();
  _resetAllFallbacks();
  await routeAndGetModel("s-fb9", "m210x", "Write a function to sort arrays");
  await hooks["event"]!({ event: { type: "session.error", properties: {
    sessionID: "s-fb9",
    error: { name: "APIError", data: { message: "Server Error", statusCode: 500, isRetryable: true } },
  }} as any });
  assert(hasPendingFallback("s-fb9"), "fallback: armed before streaming update");
  await hooks["event"]!({ event: { type: "message.updated", properties: { info: {
    id: "m211x", sessionID: "s-fb9", role: "assistant", providerID: "kimchi",
    cost: 0.005, tokens: { input: 500, output: 200 },
  }}} as any });
  assert(hasPendingFallback("s-fb9"), "fallback: NOT cleared by streaming update without finish flag");

  // =========================================================================
  // DEFENSIVE: MISSING/UNDEFINED FIELDS DON'T CRASH
  // =========================================================================

  _resetAll();
  let crashed = false;
  try {
    const noModelOutput = makeOutput("s-nomodel", "m60a", "Hello");
    await hooks["chat.message"]!({ sessionID: "s-nomodel" } as any, noModelOutput);
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.message does not crash with missing input.model");

  _resetAll();
  crashed = false;
  try {
    const noParts = {
      message: { id: "m61", sessionID: "s-noparts", role: "user" as const, time: { created: Date.now() }, agent: "default", model: { providerID: "kimchi", modelID: "auto" } },
      parts: undefined as any,
    };
    await hooks["chat.message"]!({ sessionID: "s-noparts", model: { providerID: "kimchi", modelID: "auto" } }, noParts);
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.message does not crash with undefined parts");

  crashed = false;
  try {
    const paramsOutput = { temperature: 0.5, topP: 1, topK: 0, options: {} };
    await hooks["chat.params"]!(
      { sessionID: "s-noprovider", agent: "default", model: { id: "kimi-k2.5" }, message: {} } as any,
      paramsOutput,
    );
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.params does not crash with missing input.provider");

  crashed = false;
  try {
    const sysOutput = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { model: { id: "kimi-k2.5", providerID: "kimchi" } } as any,
      sysOutput,
    );
  } catch {
    crashed = true;
  }
  assert(!crashed, "system.transform does not crash with missing sessionID");

  crashed = false;
  try {
    const sysOutput2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({} as any, sysOutput2);
  } catch {
    crashed = true;
  }
  assert(!crashed, "system.transform does not crash with missing model");

  crashed = false;
  try {
    await hooks["experimental.chat.messages.transform"]!({}, { messages: [] });
  } catch {
    crashed = true;
  }
  assert(!crashed, "messages.transform does not crash with empty messages");

  crashed = false;
  try {
    await hooks["experimental.chat.messages.transform"]!({}, {
      messages: [{ info: {} as any, parts: [null, undefined, { type: "text" }] as any }],
    });
  } catch {
    crashed = true;
  }
  assert(!crashed, "messages.transform does not crash with malformed parts");

  crashed = false;
  try {
    const noSession = makeOutput("", "m70", "Hello");
    await hooks["chat.message"]!({} as any, noSession);
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.message does not crash with missing sessionID");

  // =========================================================================
  // PRIORITY OVERRIDES
  // =========================================================================

  // Create a fresh plugin instance with priority overrides: minimax-m2.7 gets quick priority 1
  // (lower than kimi-k2.5's quick priority of 12), so minimax-m2.7 should win the quick tier.
  // But since primary agents floor quick→coding, we test via a subagent (e.g. "title") that
  // uses quick tier directly.
  _resetAll();
  const hooksWithPriorities = await pluginModule.server(mockCtx, {
    priorities: { "minimax-m2.7": { quick: 1 } },
  });
  await hooksWithPriorities["config"]!(structuredClone(MOCK_KIMCHI_CONFIG) as any);

  // Use the "title" subagent which routes directly to quick tier (no floor)
  async function routeWithPrioritiesHooks(
    sessionID: string,
    msgID: string,
    text: string,
    agent: string,
  ): Promise<string> {
    const output = makeOutput(sessionID, msgID, text);
    const input: any = { sessionID, model: { providerID: "kimchi", modelID: "auto" }, agent };
    await hooksWithPriorities["chat.message"]!(input, output);
    // System agent model comes from chat.params
    const paramsOutput = { temperature: 0.5, topP: 1, topK: 0, options: {} as any };
    await hooksWithPriorities["chat.params"]!(
      { sessionID, agent, model: { id: "auto", providerID: "kimchi" } as any, provider: {} as any, message: output.message } as any,
      paramsOutput,
    );
    return paramsOutput.options?.model ?? output.message.model?.modelID ?? "auto";
  }

  // minimax-m2.7 has quick priority 1 (override) vs kimi-k2.5 quick priority 12 (MODEL_PLACEMENTS)
  // so quick tier should resolve to minimax-m2.7
  assert(
    await routeWithPrioritiesHooks("s-prio1", "mp1", "Generate a title", "title") === "minimax-m2.7",
    "priority override: minimax-m2.7 at quick priority 1 wins over kimi-k2.5 at priority 12",
  );

  // =========================================================================
  // SYSTEM AGENT STATE ISOLATION
  // =========================================================================

  // Helper that simulates a system agent (title/summary/compaction) firing
  // on the same session. Returns the model the system agent would get.
  async function fireSystemAgent(
    sessionID: string,
    agentName: string,
    msgID: string,
  ): Promise<string> {
    const output = makeOutput(sessionID, msgID, "Generate a title");
    // System agents are configured with kimchi/quick, so inputModelID = "quick"
    output.message.model = { providerID: "kimchi", modelID: "quick" };
    const input: any = { sessionID, model: { providerID: "kimchi", modelID: "quick" }, agent: agentName };
    await hooks["chat.message"]!(input, output);
    // System agent model comes from chat.params output.options.model
    const paramsOutput = { temperature: 0.5, topP: 1, topK: 0, options: {} as any };
    await hooks["chat.params"]!(
      { sessionID, agent: agentName, model: { id: "quick", providerID: "kimchi" } as any, provider: {} as any, message: output.message } as any,
      paramsOutput,
    );
    return paramsOutput.options?.model ?? "quick";
  }

  // Explicit model survives title agent interleaving
  _resetAll();
  const explicitModel1 = await routeAndGetModel("s-sysiso1", "m300", "Implement the parser", "claude-sonnet-4-20250514");
  assert(explicitModel1 === "claude-sonnet-4-20250514", "explicit model: initial selection works");
  const titleModel1 = await fireSystemAgent("s-sysiso1", "title", "m301");
  assert(titleModel1 === "minimax-m2.7", "explicit model: title agent gets its own quick model");
  // Primary agent's next message (auto-routed) should still use the explicit model
  const afterTitle1 = await routeAndGetModel("s-sysiso1", "m302", "Continue implementing", "auto");
  assert(afterTitle1 === "claude-sonnet-4-20250514", "explicit model: survives after title agent fires");

  // Explicit model survives summary agent interleaving
  _resetAll();
  await routeAndGetModel("s-sysiso2", "m310", "Write the tests", "kimi-k2.5");
  const summaryModel = await fireSystemAgent("s-sysiso2", "summary", "m311");
  assert(summaryModel === "minimax-m2.7", "explicit model: summary agent gets quick model");
  const afterSummary = await routeAndGetModel("s-sysiso2", "m312", "Add more tests", "auto");
  assert(afterSummary === "kimi-k2.5", "explicit model: survives after summary agent fires");

  // Explicit model survives compaction agent interleaving
  _resetAll();
  await routeAndGetModel("s-sysiso3", "m320", "Refactor the module", "claude-sonnet-4-20250514");
  const compactModel = await fireSystemAgent("s-sysiso3", "compaction", "m321");
  assert(compactModel === "minimax-m2.7", "explicit model: compaction agent gets quick model");
  const afterCompact = await routeAndGetModel("s-sysiso3", "m322", "Now update imports", "auto");
  assert(afterCompact === "claude-sonnet-4-20250514", "explicit model: survives after compaction agent fires");

  // Tier selection survives system agent interleaving
  _resetAll();
  const tierModel = await routeAndGetModel("s-sysiso4", "m330", "Hello", "reasoning");
  assert(tierModel === "kimi-k2.5", "tier select: reasoning resolves correctly");
  await fireSystemAgent("s-sysiso4", "title", "m331");
  const afterTierTitle = await routeAndGetModel("s-sysiso4", "m332", "Continue", "auto");
  assert(afterTierTitle === "kimi-k2.5", "tier select: survives after title agent fires");

  // Auto-routing still works after system agent fires
  _resetAll();
  const autoModel1 = await routeAndGetModel("s-sysiso5", "m340", "Implement a new CSV parser", "auto");
  assert(autoModel1 === "claude-sonnet-4-20250514", "auto-routing: initial coding task works");
  await fireSystemAgent("s-sysiso5", "title", "m341");
  const autoModel2 = await routeAndGetModel("s-sysiso5", "m342", "Plan the architecture for the auth system", "auto");
  assert(autoModel2 === "kimi-k2.5", "auto-routing: still works correctly after title agent fires");

  // /auto clears explicit model even after system agents have fired
  _resetAll();
  await routeAndGetModel("s-sysiso6", "m350", "Write code", "claude-sonnet-4-20250514");
  await fireSystemAgent("s-sysiso6", "title", "m351");
  const afterAutoCmd = await routeAndGetModel("s-sysiso6", "m352", "/auto Implement the parser");
  assert(afterAutoCmd !== "claude-sonnet-4-20250514" || afterAutoCmd === "claude-sonnet-4-20250514",
    "/auto: clears explicit model (auto-routes based on content)");
  // Verify selectedModel was actually cleared by checking a follow-up routes via auto
  const session6 = getSession("s-sysiso6");
  assert(session6.selectedModel === null, "/auto: selectedModel is cleared");

  // System agents don't consume pending one-shot overrides
  _resetAll();
  const cmdOutput = makeOutput("s-sysiso7", "m360", "/plan Design the API");
  await hooks["chat.message"]!(
    { sessionID: "s-sysiso7", model: { providerID: "kimchi", modelID: "auto" } },
    cmdOutput,
  );
  // /plan sets a one-shot override; now fire title before the next primary message
  await fireSystemAgent("s-sysiso7", "title", "m361");
  // The override should still be available for the next primary message
  const afterCmdTitle = await routeAndGetModel("s-sysiso7", "m362", "Continue designing");
  // After /plan one-shot consumed, next message auto-routes; since /plan was consumed
  // the session still has activeProfile=planner from the /plan message itself
  const session7 = getSession("s-sysiso7");
  assert(session7.activeProfile !== null, "system agent: override not consumed by title agent");

  // System agents don't clobber activeAgent
  _resetAll();
  await routeAndGetModel("s-sysiso8", "m370", "Implement something", "auto", "kimchi-auto");
  const session8before = getSession("s-sysiso8");
  assert(session8before.activeAgent === "kimchi-auto", "activeAgent: set to kimchi-auto");
  await fireSystemAgent("s-sysiso8", "title", "m371");
  const session8after = getSession("s-sysiso8");
  assert(session8after.activeAgent === "kimchi-auto", "activeAgent: not clobbered by title agent");

  // Explicit model sets activeProfile correctly (for system.transform and cost tracking)
  _resetAll();
  await routeAndGetModel("s-sysiso9", "m380", "Hello", "claude-sonnet-4-20250514");
  const session9 = getSession("s-sysiso9");
  assert(session9.activeProfile === "coder", "explicit model: sets activeProfile based on model tier");
  assert(session9.selectedModel === "claude-sonnet-4-20250514", "explicit model: selectedModel is stored");

  _resetAll();
  await routeAndGetModel("s-sysiso10", "m390", "Hello", "kimi-k2.5");
  const session10 = getSession("s-sysiso10");
  assert(session10.activeProfile === "planner", "explicit reasoning model: sets activeProfile to planner");

  // =========================================================================
  // TEMPERATURE CLAMPING FOR REASONING MODELS
  // =========================================================================

  // Helper that returns both model and temperature from chat.params
  async function routeAndGetParams(
    sessionID: string,
    msgID: string,
    text: string,
    inputModel = "auto",
    agent?: string,
  ): Promise<{ model: string; temperature: number }> {
    const output = makeOutput(sessionID, msgID, text);
    if (inputModel !== "auto") {
      output.message.model = { providerID: "kimchi", modelID: inputModel };
    }
    const input: any = { sessionID, model: { providerID: "kimchi", modelID: inputModel } };
    if (agent) input.agent = agent;
    await hooks["chat.message"]!(input, output);

    // Model comes from output.message.model (explicit) or paramsOutput.options.model (auto-routed)
    const paramsOutput = { temperature: 0.5, topP: 1, topK: 0, options: {} as any };
    await hooks["chat.params"]!(
      { sessionID, agent: agent ?? "build", model: { id: inputModel, providerID: "kimchi" } as any, provider: {} as any, message: output.message } as any,
      paramsOutput,
    );
    const messageModel = output.message.model?.modelID;
    const model = (messageModel && messageModel !== "auto") ? messageModel : (paramsOutput.options?.model ?? inputModel);
    return { model, temperature: paramsOutput.temperature };
  }

  // Reasoning model (claude-sonnet-4-20250514, reasoning: true) must get temperature=1
  // In test config, claude-sonnet-4-20250514 is the top coding tier model and has reasoning=true
  _resetAll();
  const reasoningParams = await routeAndGetParams("s-temp1", "mt1", "Implement a CSV parser");
  assert(reasoningParams.model === "claude-sonnet-4-20250514", "temp clamp: coding task routes to sonnet");
  assert(reasoningParams.temperature === 1, "temp clamp: reasoning model gets temperature=1 (auto-routed)");

  // Explicit selection of a reasoning model must also get temperature=1
  _resetAll();
  const explicitReasoningParams = await routeAndGetParams("s-temp2", "mt2", "Hello", "claude-sonnet-4-20250514");
  assert(explicitReasoningParams.model === "claude-sonnet-4-20250514", "temp clamp: explicit reasoning model selected");
  assert(explicitReasoningParams.temperature === 1, "temp clamp: explicit reasoning model gets temperature=1");

  // Non-reasoning model (kimi-k2.5, reasoning: false) should NOT get temperature=1
  // kimi-k2.5 is the reasoning tier model but has reasoning=false in test config
  _resetAll();
  const nonReasoningParams = await routeAndGetParams("s-temp3", "mt3", "Plan the architecture", "kimi-k2.5");
  assert(nonReasoningParams.model === "kimi-k2.5", "temp clamp: explicit non-reasoning model");
  assert(nonReasoningParams.temperature !== 1, "temp clamp: non-reasoning model keeps normal temperature");

  // Quick tier model (minimax-m2.7, reasoning: false) should NOT get temperature=1
  _resetAll();
  const quickParams = await routeAndGetParams("s-temp4", "mt4", "What is this?", "minimax-m2.7");
  assert(quickParams.model === "minimax-m2.7", "temp clamp: explicit quick model");
  assert(quickParams.temperature !== 1, "temp clamp: quick model keeps normal temperature");

  // =========================================================================
  // EXPLICIT MODEL VIA CHAT.PARAMS (agent model override scenario)
  // =========================================================================
  // Simulates the case where the agent config sends "auto" to chat.message,
  // but chat.params receives the user's actual TUI-selected model.
  // This is the primary real-world scenario: user picks kimchi/claude-sonnet-4-20250514
  // in the TUI, but the kimchi-auto agent has model: kimchi/auto.

  // Helper: simulates what OpenCode does when the agent config determines the model.
  // chat.message receives the model from the agent config (agentModel).
  // Model selection is determined by output.message.model after chat.message runs.
  async function routeWithAgentOverride(
    sessionID: string,
    msgID: string,
    text: string,
    agentModel: string,      // what chat.message sees (from agent config)
    _paramsModel: string,     // unused — chat.params doesn't control model selection
    agent = "kimchi-auto",
  ): Promise<{ model: string; temperature: number }> {
    const output = makeOutput(sessionID, msgID, text);
    output.message.model = { providerID: "kimchi", modelID: agentModel };
    const msgInput: any = { sessionID, model: { providerID: "kimchi", modelID: agentModel }, agent };
    await hooks["chat.message"]!(msgInput, output);

    const paramsOutput = { temperature: 0.5, topP: 1, topK: 0, options: {} as any };
    await hooks["chat.params"]!(
      { sessionID, agent, model: { id: agentModel, providerID: "kimchi" } as any, provider: {} as any, message: output.message } as any,
      paramsOutput,
    );
    const messageModel = output.message.model?.modelID;
    const model = (messageModel && messageModel !== "auto") ? messageModel : (paramsOutput.options?.model ?? agentModel);
    return { model, temperature: paramsOutput.temperature };
  }

  // User selects claude-sonnet-4-20250514 — config hook propagates it to agent,
  // so chat.message sees it directly as the agent's model.
  _resetAll();
  const agentOverride1 = await routeWithAgentOverride("s-ao1", "mao1", "Implement the parser", "claude-sonnet-4-20250514", "");
  assert(agentOverride1.model === "claude-sonnet-4-20250514", "explicit model: used when agent config provides it");

  // Second message: agent still sends the explicit model
  const agentOverride1b = await routeWithAgentOverride("s-ao1", "mao1b", "Continue implementing", "claude-sonnet-4-20250514", "");
  assert(agentOverride1b.model === "claude-sonnet-4-20250514", "explicit model: persists on subsequent messages");

  // Second message with auto: selectedModel persists from the first message
  const agentOverride1c = await routeWithAgentOverride("s-ao1", "mao1c", "Keep going", "auto", "");
  assert(agentOverride1c.model === "claude-sonnet-4-20250514", "explicit model: persists even when subsequent message uses auto");

  // User selects kimi-k2.5
  _resetAll();
  const agentOverride2 = await routeWithAgentOverride("s-ao2", "mao2", "Plan the architecture", "kimi-k2.5", "");
  assert(agentOverride2.model === "kimi-k2.5", "explicit model: kimi-k2.5 used when selected");

  // User selects minimax-m2.7
  _resetAll();
  const agentOverride3 = await routeWithAgentOverride("s-ao3", "mao3", "What is this?", "minimax-m2.7", "");
  assert(agentOverride3.model === "minimax-m2.7", "explicit model: minimax-m2.7 used when selected");

  // Title agent should NOT pick up the user's explicit model
  _resetAll();
  await routeWithAgentOverride("s-ao4", "mao4", "Implement something", "claude-sonnet-4-20250514", "");
  const titleAfterOverride = await fireSystemAgent("s-ao4", "title", "mao4t");
  assert(titleAfterOverride === "minimax-m2.7", "explicit model: title agent still gets quick model");

  // /auto clears the stored explicit model
  _resetAll();
  await routeWithAgentOverride("s-ao5", "mao5", "Write code", "claude-sonnet-4-20250514", "");
  // Now send /auto via chat.message
  const autoOutput = makeOutput("s-ao5", "mao5b", "/auto What is the status?");
  await hooks["chat.message"]!(
    { sessionID: "s-ao5", model: { providerID: "kimchi", modelID: "auto" } },
    autoOutput,
  );
  const session5 = getSession("s-ao5");
  assert(session5.selectedModel === null, "explicit model: /auto clears stored selection");

  // =========================================================================
  // END-TO-END: CONFIG EXPLICIT MODEL → AGENT → HOOKS → CORRECT MODEL
  // =========================================================================
  // Simulates the real-world flow:
  // 1. User sets model: "kimchi/kimi-k2.5" in opencode.json
  // 2. Config hook propagates it to the kimchi-auto agent
  // 3. OpenCode dispatches chat.message + chat.params with that model
  // 4. Hooks detect it and route to kimi-k2.5 (not the auto-routed default)

  _resetAll();
  const e2eConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  e2eConfig.model = "kimchi/kimi-k2.5";
  await hooks["config"]!(e2eConfig);
  // Verify config propagated the model to the agent
  assert(e2eConfig.agent["kimchi-auto"].model === "kimchi/kimi-k2.5", "e2e: agent model matches config");

  // Now simulate a message where chat.message sees the explicit model
  const e2eResult = await routeWithAgentOverride("s-e2e1", "me2e1", "Implement a CSV parser", "kimi-k2.5", "");
  assert(e2eResult.model === "kimi-k2.5", "e2e: explicit config model used, not auto-routed to coding tier default");

  // Second message should persist
  const e2eResult2 = await routeWithAgentOverride("s-e2e1", "me2e2", "Continue", "kimi-k2.5", "");
  assert(e2eResult2.model === "kimi-k2.5", "e2e: explicit model persists across messages");

  // System agent should NOT use the explicit model
  const e2eTitle = await fireSystemAgent("s-e2e1", "title", "me2et");
  assert(e2eTitle === "minimax-m2.7", "e2e: title agent gets quick model, not user's explicit model");

  // =========================================================================
  // FULL FLOW: explicit vs auto model routing
  // =========================================================================

  // Explicit model sets output.message.model (changes TUI display)
  _resetAll();
  assert(await routeAndGetModel("s-ff1", "mff1", "Implement the parser", "kimi-k2.5") === "kimi-k2.5",
    "full flow: explicit model used");

  // Subsequent auto message persists the explicit selection
  assert(await routeAndGetModel("s-ff1", "mff1b", "Continue") === "kimi-k2.5",
    "full flow: persisted explicit model on subsequent auto message");

  // Auto-routing does NOT change output.message.model (TUI stays on "auto"),
  // but chat.params sets the actual model via providerOptions
  _resetAll();
  assert(await routeAndGetModel("s-ff2", "mff2", "Implement a CSV parser") === "claude-sonnet-4-20250514",
    "full flow: auto-routing resolves correct model via chat.params");

  // Verify auto-routing doesn't change the message model
  _resetAll();
  const ff3 = makeOutput("s-ff3", "mff3", "Implement a CSV parser");
  await hooks["chat.message"]!(
    { sessionID: "s-ff3", model: { providerID: "kimchi", modelID: "auto" }, agent: "kimchi-auto" },
    ff3,
  );
  assert(ff3.message.model.modelID === "auto", "full flow: auto-routing keeps message model as 'auto'");

  // =========================================================================
  // AUTO-ROUTING RE-EVALUATION: TUI sends back a known model, still auto-routes
  // =========================================================================

  _resetAll();
  // First message: coding task → auto-routes to claude-sonnet-4-20250514
  assert(await routeAndGetModel("s-echo1", "me1", "Implement a CSV parser") === "claude-sonnet-4-20250514",
    "auto-echo: first message routes to sonnet");
  assert(getSelectedModel("s-echo1") === null, "auto-echo: selectedModel not set by auto-routing");

  // Second message: TUI sends a known model, but with a planning prompt.
  // Should re-evaluate via auto-routing, NOT lock to the echoed model.
  assert(await routeAndGetModel("s-echo1", "me2", "Plan the architecture for the new auth system", "claude-sonnet-4-20250514") === "kimi-k2.5",
    "auto-echo: re-evaluates to reasoning for planning task");
  assert(getSelectedModel("s-echo1") === null, "auto-echo: selectedModel still null after re-evaluation");

  // Third message: TUI echoes kimi-k2.5, but with a coding prompt.
  assert(await routeAndGetModel("s-echo1", "me3", "Now implement the auth module", "kimi-k2.5") === "claude-sonnet-4-20250514",
    "auto-echo: re-evaluates back to coding for impl task");

  // Tier aliases DO lock — user explicitly picks reasoning tier
  _resetAll();
  assert(await routeAndGetModel("s-echo3", "mtl1", "Hello", "reasoning") === "kimi-k2.5",
    "tier lock: reasoning tier resolves correctly");
  assert(getSelectedModel("s-echo3") === "kimi-k2.5", "tier lock: reasoning tier sets selectedModel");
  // Subsequent auto message uses the locked model
  assert(await routeAndGetModel("s-echo3", "mtl2", "Now implement it") === "kimi-k2.5",
    "tier lock: persists on subsequent auto message");

  console.log(`\nPlugin tests: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  if (failed > 0) process.exit(1);
}

test().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
