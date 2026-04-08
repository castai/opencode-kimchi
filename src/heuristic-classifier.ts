/**
 * Heuristic classifier — regex-based fallback for first-message-in-session routing.
 *
 * Used only when there is no conversation history for the phase detector to analyze.
 * Maps user message text to a ProfileID using keyword/pattern matching.
 *
 * 7 profiles: planner, coder, assistant, debugger, reviewer, explorer, refactorer
 */

import type { ProfileID } from "./profiles.js";

export interface ClassificationResult {
  profile: ProfileID;
  confidence: number; // 0-1
  reason: string;
}

// ---------------------------------------------------------------------------
// Signal patterns — ordered by specificity (most specific first)
// ---------------------------------------------------------------------------

const DEBUG_SIGNALS: RegExp[] = [
  /\b(debug(ging)?|diagnos(e|ing)|investigat(e|ing))\b/i,
  /\b(exception|traceback|stack ?trace|panic|segfault)\b/i,
  /\b(crash(es|ed|ing)?)\b/i,
  /\b(bug(s|gy)?|broken|fail(s|ed|ing)?|doesn'?t work|not working)\b/i,
  /\b(wrong (output|result|value|behavior)|unexpected)\b/i,
  /\b(TypeError|ReferenceError|SyntaxError|NullPointerException|undefined is not)\b/i,
  /\bwhy\b.*\b(fail|crash|throw|error|break)/i,
  /\b(root cause|regression)\b/i,
  // "error" only in diagnostic contexts, not "add error handling"
  /\b(getting|got|have|there'?s|seeing|hit|encounter) (an? )?error/i,
  /\berror\b.*\b(when|after|during|on|in)\b/i,
];

const REVIEW_SIGNALS: RegExp[] = [
  /\b(review|audit|critique|evaluate)\b.*\b(code|change|pr|pull request|commit|diff)\b/i,
  /\b(code review|security (review|audit|scan|check))\b/i,
  /\b(is this (correct|safe|secure|right|ok)|any (issues|problems|vulnerabilities))\b/i,
  /\b(look over|check (for|my)|give.+feedback)\b/i,
  /\b(pull request|pr)\b.*\b(review|check|look)\b/i,
  /\b(OWASP|XSS|SQL injection|injection|vulnerability|CVE)\b/i,
];

const REFACTOR_SIGNALS: RegExp[] = [
  /\b(refactor|restructure|reorganize|clean ?up|simplify)\b/i,
  /\b(extract|inline|rename|split|merge|move)\b.*\b(function|method|class|module|component|variable|logic|code|utility|helper)\b/i,
  /\b(extract)\b.*\b(into|to|as)\b/i,
  /\b(dedup(licate)?|DRY|reduce (complexity|duplication|nesting))\b/i,
  /\b(improve (readability|structure|naming|organization))\b/i,
];

const EXPLORE_SIGNALS: RegExp[] = [
  /\b(find|search|locate|look for|look up)\b.*\b(file|function|class|module|definition|usage|reference)\b/i,
  /\b(where (is|are|does)|which (file|module|class|function))\b/i,
  /\b(project structure|codebase|directory (structure|layout)|how is .+ (structured|organized))\b/i,
  /\blist\b.*\b(files|functions|classes|endpoints|routes|modules|components|imports|exports|dependencies)\b/i,
  /\b(navigate|grep|show me the)\b/i,
];

const PLANNER_SIGNALS: RegExp[] = [
  /\b(plan|design|architect|roadmap|strategy|approach)\b/i,
  /\b(think through|reason about|analyze|evaluate|assess|compare)\b/i,
  /\b(trade-?offs?|pros?\s+and\s+cons?|alternatives?|options?)\b/i,
  /\b(how should (we|i)|what('s| is) the best (way|approach))\b/i,
  /\b(requirements?|specifications?|constraints?)\b/i,
  /\b(research|investigate|explore|understand|deep dive)\b/i,
  /\b(why does|how does|what causes|root cause)\b/i,
  /\b(break(ing)? down|step[- ]by[- ]step|walk me through)\b/i,
  /\b(complex|complicated|tricky|subtle|nuanced)\b/i,
  /\b(security (implications?)|performance (analysis|implications?|impact))\b/i,
  /\b(should (we|i)|decide|choose between|pick)\b/i,
  /\b(migration|upgrade) (plan|strategy|path)\b/i,
  /\b(copycat|clone|replica)\b/i,
  /\b(similar (capabilities?|features?|functionality) (like|to|as))\b/i,
  /\b(build|create|make)\b.*\b(similar to|inspired by|version of)\b/i,
];

const CODER_SIGNALS: RegExp[] = [
  /\b(implement|build|create|write|add|make)\b.*\b(function|method|class|component|module|endpoint|api|route|handler|middleware|hook|service|controller|model|schema|test|migration|app|application|website|platform|tool|system|feature|page|dashboard|plugin|extension|script|bot|widget|interface)\b/i,
  /\b(add|implement|write)\b.*\b(tests?|specs?|validation|error handling|logging)\b/i,
  /\b(update|modify|change|edit|adjust)\b.*\b(code|file|function|method|class|component)\b/i,
  /\b(convert|transform|parse|serialize|format)\b/i,
  /\b(import|export|require|install|configure)\b.*\b(package|module|library|dependency)\b/i,
  /\b(commit|merge|rebase|cherry-?pick|squash)\b/i,
  /\bcreate\b.*\b(file|directory|folder|project|repo)\b/i,
  /```[\s\S]*```/,
  /\b(typescript|javascript|python|go|rust|java|css|html|sql|graphql|yaml|json|toml)\b/i,
];

const ASSISTANT_SIGNALS: RegExp[] = [
  /\b(what is|what's|what are|where is|where's|show me|list|find)\b/i,
  /\b(explain|describe|summarize|tell me about)\b/i,
  /\b(how (do|to)|is (there|it))\b/i,
  /\b(quick(ly)?|brief(ly)?|short|simple|just|only)\b/i,
  /\b(check|verify|confirm|look at|see if)\b/i,
  /\b(status|progress|state|current)\b/i,
  /\b(yes|no|ok|sure|thanks|thank you|got it)\b/i,
];

interface ScoredProfile {
  profile: ProfileID;
  score: number;
}

function countSignals(text: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(text)).length;
}

/**
 * Classify a message using regex heuristics.
 * Always returns a result (never null). Used as first-message fallback.
 */
export function classifyWithHeuristics(text: string): ClassificationResult {
  if (!text.trim()) {
    return { profile: "assistant", confidence: 0.5, reason: "empty message" };
  }

  // Score each profile with weighted signals + structural boosts
  const scores: ScoredProfile[] = [
    { profile: "debugger",   score: countSignals(text, DEBUG_SIGNALS)    * 2.0 },
    { profile: "reviewer",   score: countSignals(text, REVIEW_SIGNALS)   * 1.8 },
    { profile: "refactorer", score: countSignals(text, REFACTOR_SIGNALS) * 1.7 },
    { profile: "explorer",   score: countSignals(text, EXPLORE_SIGNALS)  * 1.5 },
    { profile: "planner",    score: countSignals(text, PLANNER_SIGNALS)  * 1.5 },
    { profile: "coder",      score: countSignals(text, CODER_SIGNALS)    * 1.3 },
    { profile: "assistant",  score: countSignals(text, ASSISTANT_SIGNALS) * 0.8 },
  ];

  // Structural boosts
  if (text.length > 500) {
    addScore(scores, "planner", 0.15);
  }
  if (text.length < 80) {
    addScore(scores, "assistant", 0.2);
  }
  if (/\.(ts|js|py|go|rs|java|tsx|jsx|css|html|sql|yaml|json|toml|md)/.test(text)) {
    addScore(scores, "coder", 0.1);
  }
  if (/```/.test(text)) {
    addScore(scores, "coder", 0.15);
  }
  // Error indicators boost debugger — but only when the error is *happening*,
  // not when the user is asking to "add error handling" or "error messages"
  if (/\b(exception|traceback|crash(es|ed|ing)?|bug(s|gy)?|TypeError|ReferenceError|SyntaxError)\b/i.test(text)) {
    addScore(scores, "debugger", 0.3);
  }
  if (/\berror\b/i.test(text) && !/\berror (handling|message|code|type|class|boundary)/i.test(text)) {
    addScore(scores, "debugger", 0.2);
  }

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1];
  const total = scores.reduce((sum, s) => sum + s.score, 0);
  // Confidence accounts for both relative gap AND absolute signal strength.
  // A message with only a tiny structural boost (e.g. 0.2 from short message)
  // should have low confidence even if it "wins" by default.
  // This matters for mode stickiness: low-confidence detections don't break out of the current mode.
  const relativeGap = total > 0 ? (top.score - second.score) / total : 0;
  const absoluteStrength = Math.min(1.0, top.score / 1.5); // needs score >= 1.5 for full strength
  const confidence = Math.min(0.95, 0.2 + relativeGap * 0.3 + absoluteStrength * 0.45);

  // When ambiguous, default to coder (safest in a coding assistant)
  if (confidence < 0.4 && top.profile !== "coder") {
    return {
      profile: "coder",
      confidence: 0.4,
      reason: "heuristic: ambiguous, defaulting to coder",
    };
  }

  return {
    profile: top.profile,
    confidence,
    reason: `heuristic: ${top.profile} (score=${top.score.toFixed(1)})`,
  };
}

function addScore(scores: ScoredProfile[], profile: ProfileID, amount: number): void {
  const entry = scores.find((s) => s.profile === profile);
  if (entry) entry.score += amount;
}
