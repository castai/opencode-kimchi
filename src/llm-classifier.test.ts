import { classifyWithLlm } from "./llm-classifier.js";

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

const originalFetch = globalThis.fetch;

function mockFetch(responseBody: unknown, status = 200): void {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    json: async () => responseBody,
  })) as any;
}

function mockFetchError(): void {
  globalThis.fetch = (() => {
    throw new Error("network error");
  }) as any;
}

const baseOptions = {
  baseUrl: "https://llm.cast.ai/openai/v1",
  apiKey: "test-key",
  model: "minimax-m2.5",
  timeoutMs: 1000,
};

// --- Valid responses ---
{
  mockFetch({ choices: [{ message: { content: "reasoning" } }] });
  const result = await classifyWithLlm("plan the auth system", baseOptions);
  assert(result === "reasoning", "classifies 'reasoning' response");
}

{
  mockFetch({ choices: [{ message: { content: "coding" } }] });
  const result = await classifyWithLlm("implement the function", baseOptions);
  assert(result === "coding", "classifies 'coding' response");
}

{
  mockFetch({ choices: [{ message: { content: "quick" } }] });
  const result = await classifyWithLlm("what is this?", baseOptions);
  assert(result === "quick", "classifies 'quick' response");
}

// --- Handles extra text in response ---
{
  mockFetch({ choices: [{ message: { content: "coding - because the user wants implementation" } }] });
  const result = await classifyWithLlm("build a form", baseOptions);
  assert(result === "coding", "handles response with extra explanation");
}

// --- Handles uppercase/mixed case ---
{
  mockFetch({ choices: [{ message: { content: "REASONING" } }] });
  const result = await classifyWithLlm("analyze this", baseOptions);
  assert(result === "reasoning", "handles uppercase response");
}

// --- Handles whitespace ---
{
  mockFetch({ choices: [{ message: { content: "  quick  " } }] });
  const result = await classifyWithLlm("what?", baseOptions);
  assert(result === "quick", "handles whitespace in response");
}

// --- Invalid/unknown response ---
{
  mockFetch({ choices: [{ message: { content: "I think you should use a powerful model" } }] });
  const result = await classifyWithLlm("something", baseOptions);
  assert(result === null, "returns null for unrecognized response");
}

// --- Empty response ---
{
  mockFetch({ choices: [{ message: { content: "" } }] });
  const result = await classifyWithLlm("something", baseOptions);
  assert(result === null, "returns null for empty response");
}

// --- Missing choices ---
{
  mockFetch({ choices: [] });
  const result = await classifyWithLlm("something", baseOptions);
  assert(result === null, "returns null for empty choices");
}

// --- Malformed response ---
{
  mockFetch({ unexpected: "format" });
  const result = await classifyWithLlm("something", baseOptions);
  assert(result === null, "returns null for malformed response");
}

// --- HTTP error ---
{
  mockFetch({ error: "unauthorized" }, 401);
  const result = await classifyWithLlm("something", baseOptions);
  assert(result === null, "returns null on HTTP error");
}

// --- Network error ---
{
  mockFetchError();
  const result = await classifyWithLlm("something", baseOptions);
  assert(result === null, "returns null on network error");
}

// --- Null content ---
{
  mockFetch({ choices: [{ message: { content: null } }] });
  const result = await classifyWithLlm("something", baseOptions);
  assert(result === null, "returns null for null content");
}

globalThis.fetch = originalFetch;

console.log(`\nLLM classifier tests: ${passed} passed, ${failed} failed out of ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
