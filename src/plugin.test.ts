import pluginModule from "./index.js";
import { _resetAll } from "./session-state.js";

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

  // Verify module structure
  assert(pluginModule.id === "opencode-kimchi", "module has correct id");
  assert(typeof pluginModule.server === "function", "module.server is a function");

  // Initialize the plugin with a mock context
  const mockCtx = {
    client: {} as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
  };
  const hooks = await pluginModule.server(mockCtx);

  // Verify all expected hooks exist
  assert(typeof hooks["chat.message"] === "function", "chat.message hook exists");
  assert(typeof hooks["experimental.chat.system.transform"] === "function", "system.transform hook exists");
  assert(typeof hooks["experimental.chat.messages.transform"] === "function", "messages.transform hook exists");
  assert(typeof hooks["chat.params"] === "function", "chat.params hook exists");
  assert(hooks.tool !== undefined, "tool hook exists");
  assert("suggest_planner_mode" in hooks.tool!, "suggest_planner_mode tool exists");
  assert("suggest_coder_mode" in hooks.tool!, "suggest_coder_mode tool exists");
  assert("suggest_debugger_mode" in hooks.tool!, "suggest_debugger_mode tool exists");
  assert("suggest_reviewer_mode" in hooks.tool!, "suggest_reviewer_mode tool exists");
  assert("suggest_explorer_mode" in hooks.tool!, "suggest_explorer_mode tool exists");
  assert("suggest_refactorer_mode" in hooks.tool!, "suggest_refactorer_mode tool exists");
  assert("suggest_assistant_mode" in hooks.tool!, "suggest_assistant_mode tool exists");

  // Helper to create a test message output
  function makeOutput(sessionID: string, msgID: string, text: string) {
    return {
      message: { id: msgID, sessionID, role: "user" as const, time: { created: Date.now() }, agent: "default", model: { providerID: "kimchi", modelID: "kimi-k2.5" } },
      parts: [{ id: `p-${msgID}`, sessionID, messageID: msgID, type: "text" as const, text }],
    };
  }

  // =========================================================================
  // HEURISTIC ROUTING (first message, no history)
  // =========================================================================

  // Coding task
  _resetAll();
  const codingOutput = makeOutput("s-code", "m1", "Implement a new function to parse CSV files");
  await hooks["chat.message"]!({ sessionID: "s-code", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, codingOutput);
  assert(codingOutput.message.model.modelID === "glm-5-fp8", "coding task routes to glm-5-fp8");

  // Reasoning/planning task
  _resetAll();
  const reasoningOutput = makeOutput("s-plan", "m2", "Plan the architecture for the microservices migration");
  await hooks["chat.message"]!({ sessionID: "s-plan", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, reasoningOutput);
  assert(reasoningOutput.message.model.modelID === "kimi-k2.5", "planning task routes to kimi-k2.5");

  // Quick/assistant task
  _resetAll();
  const quickOutput = makeOutput("s-quick", "m3", "What is the status?");
  await hooks["chat.message"]!({ sessionID: "s-quick", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, quickOutput);
  assert(quickOutput.message.model.modelID === "minimax-m2.5", "quick task routes to minimax-m2.5");

  // Debug task
  _resetAll();
  const debugOutput = makeOutput("s-debug", "m4", "I'm getting a TypeError: Cannot read property 'id' of undefined");
  await hooks["chat.message"]!({ sessionID: "s-debug", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, debugOutput);
  assert(debugOutput.message.model.modelID === "kimi-k2.5", "debug task routes to kimi-k2.5 (reasoning model)");

  // Review task
  _resetAll();
  const reviewOutput = makeOutput("s-review", "m5", "Review this code for security vulnerabilities");
  await hooks["chat.message"]!({ sessionID: "s-review", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, reviewOutput);
  assert(reviewOutput.message.model.modelID === "kimi-k2.5", "review task routes to kimi-k2.5 (reasoning model)");

  // Explorer task
  _resetAll();
  const exploreOutput = makeOutput("s-explore", "m6", "Where is the database configuration file?");
  await hooks["chat.message"]!({ sessionID: "s-explore", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, exploreOutput);
  assert(exploreOutput.message.model.modelID === "minimax-m2.5", "explore task routes to minimax-m2.5 (quick model)");

  // Refactor task
  _resetAll();
  const refactorOutput = makeOutput("s-refactor", "m7", "Refactor the payment module to use the strategy pattern");
  await hooks["chat.message"]!({ sessionID: "s-refactor", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, refactorOutput);
  assert(refactorOutput.message.model.modelID === "glm-5-fp8", "refactor task routes to glm-5-fp8 (coding model)");

  // =========================================================================
  // SLASH COMMAND OVERRIDES
  // =========================================================================

  _resetAll();
  const planOverride = makeOutput("s-cmd1", "m10", "/plan What is the status?");
  await hooks["chat.message"]!({ sessionID: "s-cmd1", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, planOverride);
  assert(planOverride.message.model.modelID === "kimi-k2.5", "/plan forces planner model");

  const afterPlan = makeOutput("s-cmd1", "m11", "What is this?");
  await hooks["chat.message"]!({ sessionID: "s-cmd1", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, afterPlan);
  assert(afterPlan.message.model.modelID === "minimax-m2.5", "one-shot /plan clears after use");

  _resetAll();
  const debugOverride = makeOutput("s-cmd2", "m12", "/debug Check the login flow");
  await hooks["chat.message"]!({ sessionID: "s-cmd2", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, debugOverride);
  assert(debugOverride.message.model.modelID === "kimi-k2.5", "/debug forces debugger model");

  _resetAll();
  const reviewOverride = makeOutput("s-cmd3", "m13", "/review Check my code");
  await hooks["chat.message"]!({ sessionID: "s-cmd3", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, reviewOverride);
  assert(reviewOverride.message.model.modelID === "kimi-k2.5", "/review forces reviewer model");

  _resetAll();
  const exploreOverride = makeOutput("s-cmd4", "m14", "/explore Find auth files");
  await hooks["chat.message"]!({ sessionID: "s-cmd4", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, exploreOverride);
  assert(exploreOverride.message.model.modelID === "minimax-m2.5", "/explore forces explorer model");

  _resetAll();
  const refactorOverride = makeOutput("s-cmd5", "m15", "/refactor Clean up the utils");
  await hooks["chat.message"]!({ sessionID: "s-cmd5", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, refactorOverride);
  assert(refactorOverride.message.model.modelID === "glm-5-fp8", "/refactor forces refactorer model");

  // /lock and /auto
  _resetAll();
  const lockDebug = makeOutput("s-lock", "m20", "/lock debug");
  await hooks["chat.message"]!({ sessionID: "s-lock", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, lockDebug);
  assert(lockDebug.message.model.modelID === "kimi-k2.5", "/lock debug forces debugger");

  const lockedMsg = makeOutput("s-lock", "m21", "What is this?");
  await hooks["chat.message"]!({ sessionID: "s-lock", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, lockedMsg);
  assert(lockedMsg.message.model.modelID === "kimi-k2.5", "locked debug persists");

  const autoMsg = makeOutput("s-lock", "m22", "/auto What is this?");
  await hooks["chat.message"]!({ sessionID: "s-lock", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, autoMsg);
  assert(autoMsg.message.model.modelID === "minimax-m2.5", "/auto clears lock");

  // =========================================================================
  // NON-KIMCHI PROVIDER IS SKIPPED
  // =========================================================================

  _resetAll();
  const otherProvider = makeOutput("s-other", "m30", "Implement a function");
  otherProvider.message.model = { providerID: "openai", modelID: "gpt-4" };
  await hooks["chat.message"]!({ sessionID: "s-other", model: { providerID: "openai", modelID: "gpt-4" } }, otherProvider);
  assert(otherProvider.message.model.modelID === "gpt-4", "non-kimchi provider is not modified");

  // =========================================================================
  // SYSTEM PROMPT INJECTION — uses active profile, not model ID
  // =========================================================================

  _resetAll();

  // Route a debug task to set active profile
  const debugForSystem = makeOutput("s-sys", "m40", "Debug the TypeError in the handler");
  await hooks["chat.message"]!({ sessionID: "s-sys", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, debugForSystem);

  const systemOutput = { system: ["existing system prompt"] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s-sys", model: { id: "kimi-k2.5", providerID: "kimchi" } as any },
    systemOutput,
  );
  assert(systemOutput.system.length === 2, "system transform adds profile prompt");
  assert(systemOutput.system[1].includes("debugging"), "debugger profile system prompt injected (not planner)");

  // Route a review task and check system prompt changes
  const reviewForSystem = makeOutput("s-sys", "m41", "/review Check my code");
  await hooks["chat.message"]!({ sessionID: "s-sys", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, reviewForSystem);

  const systemOutput2 = { system: ["existing system prompt"] };
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s-sys", model: { id: "kimi-k2.5", providerID: "kimchi" } as any },
    systemOutput2,
  );
  assert(systemOutput2.system[1].includes("review"), "reviewer profile system prompt injected after /review");

  // =========================================================================
  // PHASE DETECTION WITH CONVERSATION HISTORY
  // =========================================================================

  _resetAll();

  const assistantMsgForHistory = (id: string, sessionID: string, text: string, tools: string[]) => ({
    info: { id, sessionID, role: "assistant" as const, time: { created: Date.now() }, parentID: "x", modelID: "glm-5-fp8", providerID: "kimchi", mode: "default", path: { cwd: "/", root: "/" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [
      { id: `p-${id}`, sessionID, messageID: id, type: "text" as const, text },
      ...tools.map((t, i) => ({
        id: `p-${id}-t${i}`, sessionID, messageID: id, type: "tool" as const, tool: t, callID: `c-${id}-${i}`,
        state: { status: "completed" as const, input: {}, output: "", title: t, metadata: {}, time: { start: 0, end: 0 } },
      })),
    ],
  });

  const messagesOutput = {
    messages: [
      { info: { id: "h1", sessionID: "s-phase", role: "user" as const, time: { created: Date.now() }, agent: "default", model: { providerID: "kimchi", modelID: "glm-5-fp8" } },
        parts: [{ id: "p-h1", sessionID: "s-phase", messageID: "h1", type: "text" as const, text: "Fix the login bug" }] },
      assistantMsgForHistory("h2", "s-phase", "I'll fix the handler", ["edit", "write"]),
      { info: { id: "h3", sessionID: "s-phase", role: "user" as const, time: { created: Date.now() }, agent: "default", model: { providerID: "kimchi", modelID: "glm-5-fp8" } },
        parts: [{ id: "p-h3", sessionID: "s-phase", messageID: "h3", type: "text" as const, text: "Also fix the validation" }] },
      assistantMsgForHistory("h4", "s-phase", "Done, updated", ["edit"]),
    ],
  };
  await hooks["experimental.chat.messages.transform"]!({}, messagesOutput);

  const phaseRouted = makeOutput("s-phase", "m50", "Now update the error handling too");
  await hooks["chat.message"]!({ sessionID: "s-phase", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, phaseRouted);
  assert(phaseRouted.message.model.modelID === "glm-5-fp8", "phase detection routes to coder after edit tool calls");

  // =========================================================================
  // MODE STICKINESS — stays in current mode unless high-confidence switch
  // =========================================================================

  _resetAll();

  // Start in debug mode with an explicit debug message
  const stickyDebug = makeOutput("s-sticky", "m80", "I'm getting a TypeError when calling the function");
  await hooks["chat.message"]!({ sessionID: "s-sticky", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, stickyDebug);
  assert(stickyDebug.message.model.modelID === "kimi-k2.5", "stickiness: initial debug routes to kimi-k2.5");

  // Follow up with a vague message — should STAY in debug mode (sticky)
  const stickyFollowup = makeOutput("s-sticky", "m81", "what about the auth module?");
  await hooks["chat.message"]!({ sessionID: "s-sticky", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, stickyFollowup);
  assert(stickyFollowup.message.model.modelID === "kimi-k2.5", "stickiness: vague follow-up stays in debug mode");

  // Another vague follow-up — still sticky
  const stickyFollowup2 = makeOutput("s-sticky", "m82", "and the payment service too");
  await hooks["chat.message"]!({ sessionID: "s-sticky", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, stickyFollowup2);
  assert(stickyFollowup2.message.model.modelID === "kimi-k2.5", "stickiness: another vague follow-up stays in debug mode");

  // Explicit mode switch with slash command breaks stickiness
  const stickyOverride = makeOutput("s-sticky", "m83", "/code implement the fix");
  await hooks["chat.message"]!({ sessionID: "s-sticky", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, stickyOverride);
  assert(stickyOverride.message.model.modelID === "glm-5-fp8", "stickiness: /code breaks out of sticky debug");

  // High-confidence detection should also break stickiness
  _resetAll();
  const stickyPlan = makeOutput("s-sticky2", "m90", "Plan the architecture for the new auth system");
  await hooks["chat.message"]!({ sessionID: "s-sticky2", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, stickyPlan);
  // Now established in planner mode. A strong refactor signal should switch:
  const stickyRefactor = makeOutput("s-sticky2", "m91", "Refactor the payment module to clean up the duplicated validation code");
  await hooks["chat.message"]!({ sessionID: "s-sticky2", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, stickyRefactor);
  assert(stickyRefactor.message.model.modelID === "glm-5-fp8", "stickiness: high-confidence refactor breaks out of planner");

  // =========================================================================
  // DEFENSIVE: MISSING/UNDEFINED FIELDS DON'T CRASH
  // =========================================================================

  // chat.message with no model field
  _resetAll();
  let crashed = false;
  try {
    const noModelOutput = makeOutput("s-nomodel", "m60", "Hello");
    await hooks["chat.message"]!({ sessionID: "s-nomodel" } as any, noModelOutput);
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.message does not crash with missing input.model");

  // chat.message with undefined parts
  _resetAll();
  crashed = false;
  try {
    const noParts = {
      message: { id: "m61", sessionID: "s-noparts", role: "user" as const, time: { created: Date.now() }, agent: "default", model: { providerID: "kimchi", modelID: "kimi-k2.5" } },
      parts: undefined as any,
    };
    await hooks["chat.message"]!({ sessionID: "s-noparts", model: { providerID: "kimchi", modelID: "kimi-k2.5" } }, noParts);
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.message does not crash with undefined parts");

  // chat.params with no provider field (the original bug!)
  crashed = false;
  try {
    const paramsOutput = { temperature: 0.5, topP: 1, topK: 0, options: {} };
    await hooks["chat.params"]!(
      { sessionID: "s-noprovider", agent: "default", model: { id: "glm-5-fp8" }, message: {} } as any,
      paramsOutput,
    );
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.params does not crash with missing input.provider");

  // chat.params with undefined provider.info
  crashed = false;
  try {
    const paramsOutput2 = { temperature: 0.5, topP: 1, topK: 0, options: {} };
    await hooks["chat.params"]!(
      { sessionID: "s-noinfo", agent: "default", model: { id: "glm-5-fp8" }, provider: {} } as any,
      paramsOutput2,
    );
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.params does not crash with missing input.provider.info");

  // chat.params with undefined provider.info.id
  crashed = false;
  try {
    const paramsOutput3 = { temperature: 0.5, topP: 1, topK: 0, options: {} };
    await hooks["chat.params"]!(
      { sessionID: "s-noid", agent: "default", model: { id: "glm-5-fp8" }, provider: { info: {} } } as any,
      paramsOutput3,
    );
  } catch {
    crashed = true;
  }
  assert(!crashed, "chat.params does not crash with missing input.provider.info.id");

  // system.transform with no sessionID
  crashed = false;
  try {
    const sysOutput = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { model: { id: "glm-5-fp8", providerID: "kimchi" } } as any,
      sysOutput,
    );
  } catch {
    crashed = true;
  }
  assert(!crashed, "system.transform does not crash with missing sessionID");

  // system.transform with no model
  crashed = false;
  try {
    const sysOutput2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({} as any, sysOutput2);
  } catch {
    crashed = true;
  }
  assert(!crashed, "system.transform does not crash with missing model");

  // messages.transform with empty messages
  crashed = false;
  try {
    await hooks["experimental.chat.messages.transform"]!({}, { messages: [] });
  } catch {
    crashed = true;
  }
  assert(!crashed, "messages.transform does not crash with empty messages");

  // messages.transform with malformed message parts
  crashed = false;
  try {
    await hooks["experimental.chat.messages.transform"]!({}, {
      messages: [{ info: {} as any, parts: [null, undefined, { type: "text" }] as any }],
    });
  } catch {
    crashed = true;
  }
  assert(!crashed, "messages.transform does not crash with malformed parts");

  // chat.message with missing sessionID
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
