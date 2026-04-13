/**
 * Conversation phase detector — analyzes message history to determine
 * the current phase of the coding session.
 *
 * Instead of classifying individual messages (dumb guessing), this looks at
 * structural signals across the conversation: tool call patterns, message
 * lengths, content characteristics, and transition keywords.
 *
 * 7 phases mapped to 6 profiles:
 *   discussion    -> planner     (architecture, trade-offs)
 *   implementation -> coder      (writing new code)
 *   debugging     -> debugger    (root cause analysis, fixing errors)
 *   reviewing     -> reviewer    (code review, security audit)
 *   exploring     -> assistant   (finding files, navigating codebase)
 *   refactoring   -> refactorer  (restructuring existing code)
 *   qa            -> assistant   (quick questions, confirmations)
 *
 * Zero API calls, sub-millisecond, no dependencies.
 */

import type { ProfileID } from "./profiles.js";
import type { ConversationSignals } from "./session-state.js";

export type ConversationPhase =
  | "discussion"
  | "implementation"
  | "debugging"
  | "reviewing"
  | "exploring"
  | "refactoring"
  | "qa";

export interface PhaseDetectionResult {
  phase: ConversationPhase;
  profile: ProfileID;
  confidence: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Keyword patterns for the latest user message
// ---------------------------------------------------------------------------

const PLAN_KEYWORDS = /\b(plan|think|design|architect|how should|what if|alternatives|trade-?offs?|pros?\s+and\s+cons?|let'?s (think|plan|discuss|consider)|before we (start|begin|code)|step back|break(ing)? down|requirements?|strategy|roadmap|approach)\b/i;

const IMPLEMENT_KEYWORDS = /\b(implement|build|code|write|create|do it|go ahead|make it|let'?s (start|begin|do)|start (coding|implementing|building)|now (build|code|implement|write|fix)|add (a |the )?(function|method|class|component|endpoint|feature|test))\b/i;

const DEBUG_KEYWORDS = /\b(debug|bug(s|gy)?|crash(es|ed|ing)?|exception|traceback|stack ?trace|failing|broken|doesn'?t work|not working|wrong (output|result|value|behavior)|unexpected|undefined is not|null (pointer|reference)|segfault|panic|unhandled|TypeError|ReferenceError|SyntaxError|runtime error|log shows|the (error|issue|problem) is|why (is|does|did) (it|this)|what'?s (wrong|happening|going on)|investigate|diagnose|root cause)\b/i;
// "error" alone is too broad (matches "error handling") — use contextual pattern
const DEBUG_ERROR_CONTEXT = /\b(getting|got|have|seeing|hit|encounter|throws?|raised?) (an? )?error\b|\berror\b.*\b(when|after|during|on (line|startup|deploy))\b/i;

const REVIEW_KEYWORDS = /\b(review|audit|check (for|if|the|my|this)|look over|evaluate|assess|critique|feedback|is this (correct|safe|secure|right|ok)|any (issues|problems|bugs|vulnerabilities)|security (review|audit|check|scan)|code review|pull request|pr review|could you review|what do you think (of|about))\b/i;

const EXPLORE_KEYWORDS = /\b(find|search|where (is|are|does)|show me|locate|look for|list (all|the)|how (is|are) .+ (structured|organized)|what files|which (file|module|class|function)|codebase|project structure|directory|navigate|grep|look up)\b/i;

const REFACTOR_KEYWORDS = /\b(refactor|restructure|reorganize|clean ?up|simplify|extract|inline|rename|split|merge|move|dedup(licate)?|dry|reduce (complexity|duplication|nesting)|improve (readability|structure|naming))\b/i;

const QA_KEYWORDS = /\b(what (is|does|are)|explain|how do (i|you)|tell me about|summarize|describe|status|thanks|thank you|yes|no|ok|sure|got it|can you|quick(ly)?)\b/i;

// Tool names that indicate file-editing activity
const EDIT_TOOLS = new Set(["write", "edit", "patch", "bash", "shell", "file_write", "file_edit"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "search", "find", "file_read"]);

/**
 * Extract conversation signals from the message history.
 */
export function extractSignals(
  messages: Array<{ info: { role: string }; parts: Array<{ type: string; tool?: string; text?: string }> }>,
): ConversationSignals {
  const recent = messages.slice(-6);

  let recentToolCalls = 0;
  let recentEditToolCalls = 0;
  let recentReadToolCalls = 0;
  let userMsgLengths: number[] = [];
  let assistantMsgLengths: number[] = [];
  let codeBlockCount = 0;
  let errorMentions = 0;

  for (const msg of recent) {
    const isUser = msg.info.role === "user";
    const isAssistant = msg.info.role === "assistant";

    let textContent = "";

    for (const part of msg.parts) {
      if (part.type === "tool") {
        recentToolCalls++;
        const toolName = (part.tool ?? "").toLowerCase();
        if (EDIT_TOOLS.has(toolName)) recentEditToolCalls++;
        if (READ_TOOLS.has(toolName)) recentReadToolCalls++;
      }
      if (part.type === "text" && part.text) {
        textContent += part.text;
      }
    }

    // Count code blocks
    const blocks = textContent.match(/```/g);
    if (blocks) codeBlockCount += Math.floor(blocks.length / 2);

    // Count error-related mentions
    if (/\b(error|exception|traceback|stack ?trace|crash|bug|fail(ed|ing|ure)?)\b/i.test(textContent)) {
      errorMentions++;
    }

    if (isUser && textContent) userMsgLengths.push(textContent.length);
    if (isAssistant && textContent) assistantMsgLengths.push(textContent.length);
  }

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  return {
    recentToolCalls,
    recentEditToolCalls,
    recentReadToolCalls,
    avgUserMsgLength: avg(userMsgLengths),
    avgAssistantMsgLength: avg(assistantMsgLengths),
    codeBlockCount,
    errorMentions,
    totalMessages: messages.length,
  };
}

/**
 * Detect the conversation phase from signals and the latest user message.
 *
 * Detection priority:
 * 1. Error/debug signals (strongest — user is stuck, needs the reasoning model)
 * 2. Review keywords (explicit request for critical analysis)
 * 3. Refactor keywords (explicit request for code transformation)
 * 4. Tool usage patterns (structural signal from conversation history)
 * 5. Explore keywords + read-heavy tool usage
 * 6. Implementation transition keywords
 * 7. Planning transition keywords
 * 8. Q&A patterns (short exchanges)
 * 9. Long discussion without tools → planning
 * 10. Default → coder
 */
export function detectPhase(
  signals: ConversationSignals,
  latestUserText: string,
): PhaseDetectionResult {

  // --- Debugging: error signals are the strongest indicator ---
  const hasDebugKeywords = DEBUG_KEYWORDS.test(latestUserText) || DEBUG_ERROR_CONTEXT.test(latestUserText);

  // If the conversation is full of errors AND the latest message is about debugging
  if (signals.errorMentions >= 2 && hasDebugKeywords) {
    return {
      phase: "debugging",
      profile: "debugger",
      confidence: 0.9,
      reason: `phase: debugging (${signals.errorMentions} error mentions + debug keywords)`,
    };
  }
  // Latest message explicitly about debugging even without history
  if (hasDebugKeywords && !IMPLEMENT_KEYWORDS.test(latestUserText)) {
    const debugScore = countMatches(latestUserText, [
      /\b(bug|crash(es|ed|ing)?|exception|traceback|not working|doesn'?t work|broken|fail(s|ed|ing)?)\b/i,
      /\b(debug|diagnose|investigate|root cause)\b/i,
      /\bwhy\b.*\b(fail|crash|throw|error|break)/i,
      /\b(stack ?trace|TypeError|ReferenceError|undefined is not|null pointer)\b/i,
      DEBUG_ERROR_CONTEXT,
    ]);
    if (debugScore >= 1) {
      return {
        phase: "debugging",
        profile: "debugger",
        confidence: 0.75,
        reason: "phase: debugging (debug keywords in message)",
      };
    }
  }

  // --- Review: explicit review/audit request ---
  if (REVIEW_KEYWORDS.test(latestUserText)) {
    const reviewScore = countMatches(latestUserText, [
      /\b(review|audit|critique|evaluate|assess)\b/i,
      /\b(security|vulnerabilities?|safe|secure)\b/i,
      /\b(is this (correct|right|ok|safe)|any (issues|problems|bugs))\b/i,
      /\b(pull request|pr|code review|look over|feedback)\b/i,
    ]);
    if (reviewScore >= 1) {
      return {
        phase: "reviewing",
        profile: "reviewer",
        confidence: 0.75,
        reason: "phase: reviewing (review/audit keywords)",
      };
    }
  }

  // --- Refactoring: explicit refactor request ---
  if (REFACTOR_KEYWORDS.test(latestUserText)) {
    return {
      phase: "refactoring",
      profile: "refactorer",
      confidence: 0.75,
      reason: "phase: refactoring (refactor keywords detected)",
    };
  }

  // --- Heavy editing in history → implementation ---
  if (signals.recentEditToolCalls >= 2) {
    // But if the latest message is clearly about debugging (not just "fix the X"), override
    if (hasDebugKeywords && !IMPLEMENT_KEYWORDS.test(latestUserText)) {
      return {
        phase: "debugging",
        profile: "debugger",
        confidence: 0.7,
        reason: "phase: debugging (debug keywords after editing activity)",
      };
    }
    return {
      phase: "implementation",
      profile: "coder",
      confidence: 0.85,
      reason: `phase: implementation (${signals.recentEditToolCalls} recent edit tool calls)`,
    };
  }

  // --- Exploring: read-heavy activity + explore keywords ---
  if (EXPLORE_KEYWORDS.test(latestUserText)) {
    // Pure exploration (no implementation keywords)
    if (!IMPLEMENT_KEYWORDS.test(latestUserText) && !PLAN_KEYWORDS.test(latestUserText)) {
      return {
        phase: "exploring",
        profile: "assistant",
        confidence: 0.7,
        reason: "phase: exploring (exploration keywords)",
      };
    }
  }
  // Read-heavy tool usage without editing
  if (signals.recentReadToolCalls >= 3 && signals.recentEditToolCalls === 0) {
    return {
      phase: "exploring",
      profile: "assistant",
      confidence: 0.65,
      reason: `phase: exploring (${signals.recentReadToolCalls} read tool calls, no edits)`,
    };
  }

  // --- Implementation transition keywords ---
  if (IMPLEMENT_KEYWORDS.test(latestUserText)) {
    return {
      phase: "implementation",
      profile: "coder",
      confidence: 0.75,
      reason: "phase: implementation (transition keyword detected)",
    };
  }

  // --- Planning transition keywords ---
  if (PLAN_KEYWORDS.test(latestUserText)) {
    return {
      phase: "discussion",
      profile: "planner",
      confidence: 0.75,
      reason: "phase: discussion (planning keyword detected)",
    };
  }

  // --- Short Q&A exchanges ---
  if (
    signals.avgUserMsgLength < 80 &&
    signals.avgAssistantMsgLength < 300 &&
    signals.recentToolCalls === 0 &&
    QA_KEYWORDS.test(latestUserText)
  ) {
    return {
      phase: "qa",
      profile: "assistant",
      confidence: 0.7,
      reason: "phase: qa (short exchanges, no tools, qa keywords)",
    };
  }

  // --- Long text-heavy exchanges without tool usage → planning ---
  if (
    signals.avgUserMsgLength > 200 &&
    signals.recentToolCalls === 0 &&
    signals.totalMessages >= 4
  ) {
    return {
      phase: "discussion",
      profile: "planner",
      confidence: 0.65,
      reason: "phase: discussion (long text exchanges, no tool usage)",
    };
  }

  // --- Code blocks in conversation → implementation ---
  if (signals.codeBlockCount >= 2) {
    return {
      phase: "implementation",
      profile: "coder",
      confidence: 0.6,
      reason: `phase: implementation (${signals.codeBlockCount} code blocks in conversation)`,
    };
  }

  // --- Some tool calls → implementation ---
  if (signals.recentToolCalls > 0) {
    return {
      phase: "implementation",
      profile: "coder",
      confidence: 0.6,
      reason: `phase: implementation (${signals.recentToolCalls} tool calls detected)`,
    };
  }

  // --- Very short message, early conversation → Q&A ---
  if (latestUserText.length < 60 && signals.totalMessages < 4 && QA_KEYWORDS.test(latestUserText)) {
    return {
      phase: "qa",
      profile: "assistant",
      confidence: 0.6,
      reason: "phase: qa (short message, early conversation)",
    };
  }

  // --- Default: coder (safest in a coding assistant) ---
  return {
    phase: "implementation",
    profile: "coder",
    confidence: 0.4,
    reason: "phase: implementation (default — no strong signals)",
  };
}

/** Count how many patterns match the text */
function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(text)).length;
}
