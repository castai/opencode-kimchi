import { classifyWithHeuristics } from "./heuristic-classifier.js";
import type { ProfileID } from "./profiles.js";

interface TestCase {
  input: string;
  expected: ProfileID;
  label: string;
}

const cases: TestCase[] = [
  // --- Planner ---
  { input: "Plan the authentication system architecture", expected: "planner", label: "planning" },
  { input: "What are the trade-offs between REST and GraphQL for this project?", expected: "planner", label: "trade-offs" },
  { input: "Analyze the performance implications of switching to a microservices architecture", expected: "planner", label: "perf analysis" },
  { input: "How should we approach the database migration strategy?", expected: "planner", label: "strategy" },
  { input: "Research how other teams handle real-time sync with conflict resolution", expected: "planner", label: "research" },
  { input: "Think through the security implications of storing tokens in localStorage vs httpOnly cookies", expected: "planner", label: "security analysis" },
  { input: "Compare the alternatives for state management — Redux vs Zustand vs Jotai", expected: "planner", label: "compare alternatives" },
  { input: "Break down the requirements for the notification system", expected: "planner", label: "requirements" },

  // --- Coder ---
  { input: "Implement the user registration endpoint with email validation", expected: "coder", label: "implement endpoint" },
  { input: "Add unit tests for the CartService class", expected: "coder", label: "add tests" },
  { input: "Create a new React component for the dashboard sidebar", expected: "coder", label: "create component" },
  { input: "Update the API handler to return proper error codes\n```typescript\napp.get('/users', async (req, res) => {\n  // current code\n});\n```", expected: "coder", label: "update with code" },
  { input: "Convert the callback-based function to use async/await", expected: "coder", label: "convert code" },
  { input: "Add error handling to src/services/payment.ts", expected: "coder", label: "add error handling" },
  { input: "can you build a full application", expected: "coder", label: "build full app" },

  // --- Debugger ---
  { input: "I'm getting a TypeError: Cannot read property 'id' of undefined", expected: "debugger", label: "TypeError" },
  { input: "The app crashes when I click the submit button", expected: "debugger", label: "crash report" },
  { input: "Debug why the API returns 500 errors on the /users endpoint", expected: "debugger", label: "debug API errors" },
  { input: "This function doesn't work — it returns the wrong value", expected: "debugger", label: "wrong output" },
  { input: "Why does the test fail with 'expected 3, got undefined'?", expected: "debugger", label: "test failure" },
  { input: "There's a regression — the login stopped working after the last deploy", expected: "debugger", label: "regression" },
  { input: "Investigate the null pointer exception in the payment handler", expected: "debugger", label: "investigate null" },

  // --- Reviewer ---
  { input: "Review this code for security vulnerabilities", expected: "reviewer", label: "security review" },
  { input: "Can you audit this PR for any issues?", expected: "reviewer", label: "PR audit" },
  { input: "Is this implementation safe? Check for XSS or injection risks", expected: "reviewer", label: "XSS check" },
  { input: "Give me feedback on this code — any problems?", expected: "reviewer", label: "code feedback" },
  { input: "Code review the authentication module", expected: "reviewer", label: "code review" },

  // --- Assistant (now includes exploration) ---
  { input: "Where is the database connection configured?", expected: "assistant", label: "find config" },
  { input: "Find all files that import the UserService class", expected: "assistant", label: "find imports" },
  { input: "How is the project directory structured?", expected: "assistant", label: "project structure" },
  { input: "Which file handles the /api/auth route?", expected: "assistant", label: "find route handler" },
  { input: "List all the API endpoints in the project", expected: "assistant", label: "list endpoints" },
  { input: "What is a monad?", expected: "assistant", label: "what is" },
  { input: "Yes", expected: "assistant", label: "yes" },
  { input: "Thanks", expected: "assistant", label: "thanks" },
  { input: "ok", expected: "assistant", label: "ok" },

  // --- Refactorer ---
  { input: "Refactor the payment module to use the strategy pattern", expected: "refactorer", label: "refactor pattern" },
  { input: "Clean up the duplicated code in the validation functions", expected: "refactorer", label: "clean up duplication" },
  { input: "Simplify the nested if-else in the auth middleware", expected: "refactorer", label: "simplify nesting" },
  { input: "Extract the common logic into a shared utility", expected: "refactorer", label: "extract utility" },
  { input: "Rename the variable from 'data' to something more descriptive", expected: "refactorer", label: "rename variable" },

  // --- Edge cases ---
  { input: "", expected: "assistant", label: "empty" },
  { input: "   ", expected: "assistant", label: "whitespace" },

  // --- Regression: product clones route to planner ---
  { input: "can you build me an app that would have similar capabilities like lovable? Complete copycat of lovable", expected: "planner", label: "lovable copycat" },
  { input: "build me an app similar to notion", expected: "planner", label: "build app similar to" },
  { input: "create a complete clone of airbnb", expected: "planner", label: "clone product" },

  // --- Regression: "go" as verb should NOT trigger coder ---
  { input: "I want to go to the store", expected: "assistant", label: "go-verb: to store" },
  { input: "Let it go", expected: "assistant", label: "go-verb: let it go" },
  { input: "Ready to go?", expected: "assistant", label: "go-verb: ready to go" },
  { input: "Here we go again", expected: "assistant", label: "go-verb: here we go" },
  { input: "I need to go back and check", expected: "assistant", label: "go-verb: go back" },

  // --- Regression: "Go" as language SHOULD trigger coder ---
  { input: "Write a Go HTTP server", expected: "coder", label: "Go-language: server" },
  { input: "Implement the handler in golang", expected: "coder", label: "golang: handler" },

  // --- Regression: "java" vs "javascript" ---
  { input: "Write a Java class for the parser", expected: "coder", label: "java: class" },

  // --- Regression: review with code blocks should stay reviewer ---
  { input: "Review this code for bugs:\n```\nfunction foo() {}\n```", expected: "reviewer", label: "review+code: bugs" },
  { input: "Security audit this endpoint:\n```\napp.post(\"/login\", (req, res) => { db.query(req.body.sql) })\n```", expected: "reviewer", label: "review+code: security audit" },
  { input: "Any vulnerabilities in this?\n```python\nos.system(input())\n```", expected: "reviewer", label: "review+code: vulnerabilities" },
  { input: "Is this implementation correct?\n```\nif (x > 0) return true;\n```", expected: "reviewer", label: "review+code: is correct" },
  { input: "Code review the PR diff:\n```diff\n- old line\n+ new line\n```", expected: "reviewer", label: "review+code: PR diff" },

  // --- Regression: "review for bugs" is review, not debug ---
  { input: "Review this code for bugs", expected: "reviewer", label: "review-for-bugs" },

  // --- Regression: file extension regex should not match inside compound extensions ---
  // (Note: .tsconfig should NOT boost coder; verified via regex unit test)
];

let passed = 0;
let failed = 0;

for (const tc of cases) {
  const result = classifyWithHeuristics(tc.input);
  const ok = result.profile === tc.expected;
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: "${tc.label}" — expected ${tc.expected}, got ${result.profile} (${result.reason})`,
    );
  }
}

console.log(`\nHeuristic classifier tests: ${passed} passed, ${failed} failed out of ${cases.length}`);

if (failed > 0) {
  process.exit(1);
}
