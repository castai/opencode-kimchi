import pluginModule from "./index.js";
import { _resetAll, getSession } from "./session-state.js";
import { _resetAllCosts } from "./cost-tracker.js";

const MOCK_KIMCHI_CONFIG = {
  provider: {
    kimchi: {
      models: {
        "kimi-k2.5": { reasoning: false, cost: { input: 0.6, output: 3.0 }, limit: { context: 262000, output: 32000 }, modalities: { input: ["text", "image"], output: ["text"] } },
        "minimax-m2.5": { reasoning: false, cost: { input: 0.3, output: 1.2 }, limit: { context: 196000, output: 32000 } },
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
  assert(typeof hooks["command.execute.before"] === "function", "command.execute.before hook exists");
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
  // coding: claude-sonnet-4-20250514 (priority 12) > kimi-k2.5 (priority 25) > minimax-m2.5 (priority 40)
  // quick: minimax-m2.5 (priority 10) > gpt-4.1-nano (priority 20) > kimi-k2.5 (priority 40)

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
    const output = makeOutput(sessionID, msgID, text);
    if (inputModel !== "auto") {
      output.message.model = { providerID: "kimchi", modelID: inputModel };
    }
    const input: any = { sessionID, model: { providerID: "kimchi", modelID: inputModel } };
    if (agent) input.agent = agent;
    await hooks["chat.message"]!(input, output);

    const paramsOutput = { temperature: 0.5, topP: 1, topK: 0, options: {} as any };
    await hooks["chat.params"]!(
      { sessionID, agent: agent ?? "build", model: { id: inputModel, providerID: "kimchi" } as any, provider: {} as any, message: output.message } as any,
      paramsOutput,
    );
    return paramsOutput.options?.model ?? inputModel;
  }

  // =========================================================================
  // HEURISTIC ROUTING (first message, no history)
  // =========================================================================

  _resetAll();
  assert(await routeAndGetModel("s-code", "m1", "Implement a new function to parse CSV files") === "claude-sonnet-4-20250514", "coding task routes to sonnet");

  _resetAll();
  assert(await routeAndGetModel("s-plan", "m2", "Plan the architecture for the microservices migration") === "kimi-k2.5", "planning task routes to kimi-k2.5");

  _resetAll();
  assert(await routeAndGetModel("s-quick", "m3", "What is the status?") === "minimax-m2.5", "quick task routes to minimax-m2.5");

  _resetAll();
  assert(await routeAndGetModel("s-debug", "m4", "I'm getting a TypeError: Cannot read property 'id' of undefined") === "kimi-k2.5", "debug task routes to reasoning tier");

  _resetAll();
  assert(await routeAndGetModel("s-review", "m5", "Review this code for security vulnerabilities") === "kimi-k2.5", "review task routes to reasoning tier");

  _resetAll();
  assert(await routeAndGetModel("s-explore", "m6", "Where is the database configuration file?") === "minimax-m2.5", "explore task routes to quick tier");

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
  assert(await routeAndGetModel("s-direct3", "m62", "Hello", "quick") === "minimax-m2.5", "direct quick tier resolves to best available");

  // =========================================================================
  // AGENT-BASED ROUTING
  // =========================================================================

  // Subagents skip classification and route directly to their tier
  _resetAll();
  assert(await routeAndGetModel("s-agent1", "m70", "Find all files that import UserService", "auto", "explore") === "minimax-m2.5", "explore agent routes to quick tier");

  _resetAll();
  assert(await routeAndGetModel("s-agent2", "m71", "Research best practices for auth", "auto", "general") === "claude-sonnet-4-20250514", "general agent routes to coding tier");

  // System agents always get quick tier
  _resetAll();
  assert(await routeAndGetModel("s-agent3", "m72", "Generate a title", "auto", "title") === "minimax-m2.5", "title agent routes to quick tier");

  _resetAll();
  assert(await routeAndGetModel("s-agent4", "m73", "Compact this context", "auto", "compaction") === "minimax-m2.5", "compaction agent routes to quick tier");

  _resetAll();
  assert(await routeAndGetModel("s-agent5", "m74", "Summarize the session", "auto", "summary") === "minimax-m2.5", "summary agent routes to quick tier");

  // Primary agents fall through to heuristic classification (not short-circuited)
  _resetAll();
  assert(await routeAndGetModel("s-agent6", "m75", "Plan the architecture for the auth system", "auto", "build") === "kimi-k2.5", "build agent falls through to heuristic (planning -> reasoning)");

  _resetAll();
  assert(await routeAndGetModel("s-agent7", "m76", "What is this?", "auto", "plan") === "minimax-m2.5", "plan agent falls through to heuristic (simple question -> quick)");

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

  // =========================================================================
  // KIMCHI-AUTO AGENT — DELEGATION PROMPT IN AGENT CONFIG
  // =========================================================================

  _resetAll();
  const kimchiAgentConfig: any = structuredClone(MOCK_KIMCHI_CONFIG);
  await hooks["config"]!(kimchiAgentConfig);
  assert(kimchiAgentConfig.agent?.["kimchi-auto"]?.prompt?.includes("Delegate"), "kimchi-auto agent has delegation prompt");
  assert(kimchiAgentConfig.agent?.["kimchi-auto"]?.prompt?.includes("@explore"), "kimchi-auto prompt mentions @explore");
  assert(kimchiAgentConfig.agent?.["kimchi-auto"]?.prompt?.includes("@general"), "kimchi-auto prompt mentions @general");

  // =========================================================================
  // SLASH COMMAND OVERRIDES
  // =========================================================================

  _resetAll();
  assert(await routeAndGetModel("s-cmd1", "m10", "/plan What is the status?") === "kimi-k2.5", "/plan forces reasoning model");
  assert(await routeAndGetModel("s-cmd1", "m11", "What is this?") === "minimax-m2.5", "one-shot /plan clears after use");

  _resetAll();
  assert(await routeAndGetModel("s-cmd2", "m12", "/debug Check the login flow") === "kimi-k2.5", "/debug forces reasoning model");

  _resetAll();
  assert(await routeAndGetModel("s-cmd3", "m13", "/review Check my code") === "kimi-k2.5", "/review forces reasoning model");

  _resetAll();
  assert(await routeAndGetModel("s-cmd5", "m15", "/refactor Clean up the utils") === "claude-sonnet-4-20250514", "/refactor forces coding model");

  _resetAll();
  assert(await routeAndGetModel("s-lock", "m20", "/lock debug") === "kimi-k2.5", "/lock debug forces reasoning");
  assert(await routeAndGetModel("s-lock", "m21", "What is this?") === "kimi-k2.5", "locked debug persists");
  assert(await routeAndGetModel("s-lock", "m22", "/auto What is this?") === "minimax-m2.5", "/auto clears lock");

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
  assert(systemOutput.system.length === 2, "system transform adds profile prompt");
  assert(systemOutput.system[1].includes("debugging"), "debugger profile system prompt injected");

  const reviewForSystem = makeOutput("s-sys", "m41", "/review Check my code");
  await hooks["chat.message"]!({ sessionID: "s-sys", model: { providerID: "kimchi", modelID: "auto" } }, reviewForSystem);

  const systemOutput2 = { system: ["existing system prompt"] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s-sys", model: { id: "kimi-k2.5", providerID: "kimchi" } as any },
    systemOutput2,
  );
  assert(systemOutput2.system[1].includes("review"), "reviewer profile system prompt injected after /review");

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
  assert(compactOutput.context.length === 1, "compaction injects routing context");
  assert(compactOutput.context[0].includes("debugger"), "compaction context mentions active profile");

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

  console.log(`\nPlugin tests: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  if (failed > 0) process.exit(1);
}

test().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
