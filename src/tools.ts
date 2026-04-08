/**
 * LLM self-routing tools — let the model suggest a model switch for the next turn.
 *
 * These are registered as custom tools via the plugin `tool` hook.
 * When the LLM realizes it's not the right model for the current task,
 * it can call these tools to flag the next turn for a different profile.
 */

import { tool } from "@opencode-ai/plugin";
import { setNextProfileSuggestion } from "./session-state.js";

export const suggestPlannerMode = tool({
  description:
    "Signal that the next message needs the planning/architecture model (kimi-k2.5). " +
    "Use when the task requires trade-off analysis, system design, or step-by-step planning.",
  args: {
    reason: tool.schema.string().describe("Why the planner model is needed"),
  },
  execute: async (args, ctx) => {
    setNextProfileSuggestion(ctx.sessionID, "planner");
    return `Next message → Planner mode. Reason: ${args.reason}`;
  },
});

export const suggestCoderMode = tool({
  description:
    "Signal that the next message needs the coding/implementation model (glm-5-fp8). " +
    "Use when discussion is complete and the user is ready for direct implementation.",
  args: {
    reason: tool.schema.string().describe("Why the coding model is needed"),
  },
  execute: async (args, ctx) => {
    setNextProfileSuggestion(ctx.sessionID, "coder");
    return `Next message → Coder mode. Reason: ${args.reason}`;
  },
});

export const suggestDebuggerMode = tool({
  description:
    "Signal that the next message needs the debugging model (kimi-k2.5). " +
    "Use when the user is encountering errors, crashes, or unexpected behavior that needs root cause analysis.",
  args: {
    reason: tool.schema.string().describe("Why the debugger model is needed"),
  },
  execute: async (args, ctx) => {
    setNextProfileSuggestion(ctx.sessionID, "debugger");
    return `Next message → Debugger mode. Reason: ${args.reason}`;
  },
});

export const suggestReviewerMode = tool({
  description:
    "Signal that the next message needs the code review model (kimi-k2.5). " +
    "Use when the user asks for code review, security audit, or wants a critical evaluation of their code.",
  args: {
    reason: tool.schema.string().describe("Why the reviewer model is needed"),
  },
  execute: async (args, ctx) => {
    setNextProfileSuggestion(ctx.sessionID, "reviewer");
    return `Next message → Reviewer mode. Reason: ${args.reason}`;
  },
});

export const suggestExplorerMode = tool({
  description:
    "Signal that the next message needs the exploration model (minimax-m2.5). " +
    "Use when the user just needs to find files, navigate the codebase, or look up definitions.",
  args: {
    reason: tool.schema.string().describe("Why the explorer model is needed"),
  },
  execute: async (args, ctx) => {
    setNextProfileSuggestion(ctx.sessionID, "explorer");
    return `Next message → Explorer mode. Reason: ${args.reason}`;
  },
});

export const suggestRefactorerMode = tool({
  description:
    "Signal that the next message needs the refactoring model (glm-5-fp8). " +
    "Use when the user wants to restructure, clean up, or reorganize existing code without changing behavior.",
  args: {
    reason: tool.schema.string().describe("Why the refactorer model is needed"),
  },
  execute: async (args, ctx) => {
    setNextProfileSuggestion(ctx.sessionID, "refactorer");
    return `Next message → Refactorer mode. Reason: ${args.reason}`;
  },
});

export const suggestAssistantMode = tool({
  description:
    "Signal that the next message needs the quick-response model (minimax-m2.5). " +
    "Use when the user is asking simple questions, confirmations, or lookups.",
  args: {
    reason: tool.schema.string().describe("Why the assistant model is needed"),
  },
  execute: async (args, ctx) => {
    setNextProfileSuggestion(ctx.sessionID, "assistant");
    return `Next message → Assistant mode. Reason: ${args.reason}`;
  },
});

/** All routing tools bundled for the plugin `tool` hook */
export const routingTools = {
  suggest_planner_mode: suggestPlannerMode,
  suggest_coder_mode: suggestCoderMode,
  suggest_debugger_mode: suggestDebuggerMode,
  suggest_reviewer_mode: suggestReviewerMode,
  suggest_explorer_mode: suggestExplorerMode,
  suggest_refactorer_mode: suggestRefactorerMode,
  suggest_assistant_mode: suggestAssistantMode,
};
