import { tool } from "@opencode-ai/plugin";
import { setNextTierSuggestion } from "./session-state.js";

export const suggestReasoningMode = tool({
  description:
    "Signal that the next message needs the reasoning model. " +
    "Use when the task requires trade-off analysis, system design, debugging complex issues, " +
    "code review, security audit, or step-by-step planning.",
  args: {
    reason: tool.schema.string().describe("Why the reasoning model is needed"),
  },
  execute: async (args, ctx) => {
    setNextTierSuggestion(ctx.sessionID, "reasoning");
    return `Next message → Reasoning tier. Reason: ${args.reason}`;
  },
});

export const suggestCodingMode = tool({
  description:
    "Signal that the next message needs the coding model. " +
    "Use when discussion is complete and the user is ready for direct implementation, " +
    "refactoring, or writing tests.",
  args: {
    reason: tool.schema.string().describe("Why the coding model is needed"),
  },
  execute: async (args, ctx) => {
    setNextTierSuggestion(ctx.sessionID, "coding");
    return `Next message → Coding tier. Reason: ${args.reason}`;
  },
});

export const suggestQuickMode = tool({
  description:
    "Signal that the next message needs the quick/cheap model. " +
    "Use when the user is asking simple questions, confirmations, lookups, " +
    "or navigating the codebase.",
  args: {
    reason: tool.schema.string().describe("Why the quick model is needed"),
  },
  execute: async (args, ctx) => {
    setNextTierSuggestion(ctx.sessionID, "quick");
    return `Next message → Quick tier. Reason: ${args.reason}`;
  },
});

export const routingTools = {
  suggest_reasoning_mode: suggestReasoningMode,
  suggest_coding_mode: suggestCodingMode,
  suggest_quick_mode: suggestQuickMode,
};
