import { extractSignals, detectPhase } from "./phase-detector.js";
import type { ConversationSignals } from "./session-state.js";

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

// ---------------------------------------------------------------------------
// extractSignals tests
// ---------------------------------------------------------------------------

function userMsg(text: string) {
  return {
    info: { role: "user" },
    parts: [{ type: "text", text }],
  };
}

function assistantMsg(text: string, tools: string[] = []) {
  const parts: Array<{ type: string; text?: string; tool?: string }> = [
    { type: "text", text },
  ];
  for (const t of tools) {
    parts.push({ type: "tool", tool: t });
  }
  return {
    info: { role: "assistant" },
    parts,
  };
}

function mkSignals(overrides: Partial<ConversationSignals>): ConversationSignals {
  return {
    recentToolCalls: 0,
    recentEditToolCalls: 0,
    recentReadToolCalls: 0,
    avgUserMsgLength: 100,
    avgAssistantMsgLength: 200,
    codeBlockCount: 0,
    errorMentions: 0,
    totalMessages: 4,
    ...overrides,
  };
}

// Test: empty conversation
{
  const signals = extractSignals([]);
  assert(signals.totalMessages === 0, "extractSignals: empty conversation has 0 messages");
  assert(signals.recentToolCalls === 0, "extractSignals: empty conversation has 0 tool calls");
}

// Test: simple text conversation
{
  const messages = [
    userMsg("Plan the auth system"),
    assistantMsg("Here's my plan for the auth system..."),
    userMsg("What about edge cases?"),
    assistantMsg("Good point, let me consider rate limiting and token expiry..."),
  ];
  const signals = extractSignals(messages);
  assert(signals.totalMessages === 4, "extractSignals: text conversation has 4 messages");
  assert(signals.recentToolCalls === 0, "extractSignals: text conversation has 0 tool calls");
  assert(signals.avgUserMsgLength > 0, "extractSignals: user message length > 0");
}

// Test: conversation with tool calls
{
  const messages = [
    userMsg("Fix the login bug"),
    assistantMsg("I'll edit the login handler", ["edit", "write"]),
    userMsg("Also fix the tests"),
    assistantMsg("Updating the test file", ["edit"]),
  ];
  const signals = extractSignals(messages);
  assert(signals.recentToolCalls === 3, "extractSignals: 3 tool calls detected");
  assert(signals.recentEditToolCalls === 3, "extractSignals: 3 edit tool calls detected");
}

// Test: conversation with code blocks
{
  const messages = [
    userMsg("Here's my code:\n```typescript\nconst x = 1;\n```"),
    assistantMsg("Here's the fix:\n```typescript\nconst x = 2;\n```"),
  ];
  const signals = extractSignals(messages);
  assert(signals.codeBlockCount === 2, "extractSignals: 2 code blocks detected");
}

// Test: error mentions
{
  const messages = [
    userMsg("I'm getting an error when I run the tests"),
    assistantMsg("The test failure is caused by a missing import"),
    userMsg("The exception keeps happening"),
  ];
  const signals = extractSignals(messages);
  assert(signals.errorMentions === 3, "extractSignals: 3 error mentions detected");
}

// Test: read tool calls
{
  const messages = [
    userMsg("What's in this file?"),
    assistantMsg("Let me check", ["read", "grep", "glob"]),
  ];
  const signals = extractSignals(messages);
  assert(signals.recentReadToolCalls === 3, "extractSignals: 3 read tool calls detected");
  assert(signals.recentEditToolCalls === 0, "extractSignals: 0 edit tool calls");
}

// ---------------------------------------------------------------------------
// detectPhase tests
// ---------------------------------------------------------------------------

// --- Implementation phase ---
{
  const signals = mkSignals({ recentEditToolCalls: 4, recentToolCalls: 5 });
  const result = detectPhase(signals, "Now fix the error handling");
  assert(result.phase === "implementation", "detectPhase: heavy editing -> implementation");
  assert(result.profile === "coder", "detectPhase: heavy editing -> coder profile");
  assert(result.confidence >= 0.8, "detectPhase: heavy editing -> high confidence");
}

{
  const signals = mkSignals({});
  const result = detectPhase(signals, "OK let's start coding now");
  assert(result.phase === "implementation", "detectPhase: 'let's start coding' -> implementation");
  assert(result.profile === "coder", "detectPhase: transition keyword -> coder");
}

// --- Discussion/planning phase ---
{
  const signals = mkSignals({ recentToolCalls: 3, recentEditToolCalls: 1 });
  const result = detectPhase(signals, "Let's think about how we should approach the authentication");
  assert(result.phase === "discussion", "detectPhase: 'let's think' -> discussion");
  assert(result.profile === "planner", "detectPhase: planning transition -> planner");
}

{
  const signals = mkSignals({ avgUserMsgLength: 350, avgAssistantMsgLength: 800, totalMessages: 6 });
  const result = detectPhase(signals, "I also want to consider how the caching layer interacts with the database");
  assert(result.phase === "discussion", "detectPhase: long text exchanges -> discussion");
  assert(result.profile === "planner", "detectPhase: long discussion -> planner");
}

// --- Debugging phase ---
{
  const signals = mkSignals({ errorMentions: 3 });
  const result = detectPhase(signals, "Debug why the test is failing");
  assert(result.phase === "debugging", "detectPhase: errors + debug keywords -> debugging");
  assert(result.profile === "debugger", "detectPhase: debugging -> debugger profile");
  assert(result.confidence >= 0.85, "detectPhase: strong debug signal -> high confidence");
}

{
  const signals = mkSignals({});
  const result = detectPhase(signals, "I'm getting a TypeError when I call the function");
  assert(result.phase === "debugging", "detectPhase: error mention in message -> debugging");
  assert(result.profile === "debugger", "detectPhase: error -> debugger");
}

{
  const signals = mkSignals({ recentEditToolCalls: 3, recentToolCalls: 4 });
  const result = detectPhase(signals, "Now there's a new error after the edit — it crashes on startup");
  assert(result.phase === "debugging", "detectPhase: debug keywords override edit activity");
  assert(result.profile === "debugger", "detectPhase: debug keywords after edits -> debugger");
}

// --- Review phase ---
{
  const signals = mkSignals({});
  const result = detectPhase(signals, "Review this code for security vulnerabilities");
  assert(result.phase === "reviewing", "detectPhase: review keywords -> reviewing");
  assert(result.profile === "reviewer", "detectPhase: review -> reviewer profile");
}

{
  const signals = mkSignals({});
  const result = detectPhase(signals, "Is this implementation safe? Any issues?");
  assert(result.phase === "reviewing", "detectPhase: 'is this safe?' -> reviewing");
  assert(result.profile === "reviewer", "detectPhase: safety check -> reviewer");
}

// --- Exploring phase ---
{
  const signals = mkSignals({});
  const result = detectPhase(signals, "Where is the database configuration?");
  assert(result.phase === "exploring", "detectPhase: 'where is' -> exploring");
  assert(result.profile === "assistant", "detectPhase: locate -> assistant profile");
}

{
  const signals = mkSignals({ recentReadToolCalls: 5 });
  const result = detectPhase(signals, "Keep looking around");
  assert(result.phase === "exploring", "detectPhase: heavy read tools -> exploring");
  assert(result.profile === "assistant", "detectPhase: read-heavy -> assistant profile");
}

// --- Refactoring phase ---
{
  const signals = mkSignals({});
  const result = detectPhase(signals, "Refactor the payment module to use the strategy pattern");
  assert(result.phase === "refactoring", "detectPhase: refactor keyword -> refactoring");
  assert(result.profile === "refactorer", "detectPhase: refactor -> refactorer profile");
}

{
  const signals = mkSignals({});
  const result = detectPhase(signals, "Clean up the duplicated code in these functions");
  assert(result.phase === "refactoring", "detectPhase: 'clean up' -> refactoring");
  assert(result.profile === "refactorer", "detectPhase: cleanup -> refactorer");
}

// --- Q&A phase ---
{
  const signals = mkSignals({ avgUserMsgLength: 30, avgAssistantMsgLength: 100 });
  const result = detectPhase(signals, "What is this function doing?");
  assert(result.phase === "qa", "detectPhase: short Q&A -> qa");
  assert(result.profile === "assistant", "detectPhase: Q&A -> assistant");
}

// --- Default (ambiguous) ---
{
  const signals = mkSignals({});
  const result = detectPhase(signals, "Do the thing");
  assert(result.phase === "implementation", "detectPhase: ambiguous -> implementation (default)");
  assert(result.profile === "coder", "detectPhase: ambiguous -> coder (default)");
}

// --- Code blocks -> implementation ---
{
  const signals = mkSignals({ codeBlockCount: 3 });
  const result = detectPhase(signals, "Update that same function");
  assert(result.phase === "implementation", "detectPhase: code blocks -> implementation");
  assert(result.profile === "coder", "detectPhase: code blocks -> coder");
}

console.log(`\nPhase detector tests: ${passed} passed, ${failed} failed out of ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
