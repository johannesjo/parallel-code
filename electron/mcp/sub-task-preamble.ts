function preamble(verifyLine: string): string {
  return `[SUB-TASK MODE] You are a coordinated sub-task inside Parallel Code. A coordinator agent dispatched you to complete specific work.

You have two sub-task MCP tools available via the parallel-code server:

- land_self — Happy-path finish line. Call this after committing your work and passing verification. The backend will merge your branch into the coordinator branch and clean up your task.
- signal_done — Legacy/manual-review finish line. Use this only if the coordinator explicitly asks to review and land your branch manually.

RULES:
1. Complete your assigned work fully before calling land_self. Before landing:
   - Commit all changes (git add -A && git commit) with a meaningful message.
   - Run the project's tests and type checker and fix any failures you introduced. \
land_self requires structured verification — do not call it if tests or typecheck are failing, blocked, or unknown.
${verifyLine}2. Ask questions if requirements are unclear or if you are about to do something risky or destructive — the user can see your terminal and can respond.
3. When your work is done, call land_self with the checks you ran. Do NOT call signal_done after a successful land_self, ask "what would you like to do?", or offer merge/PR options. Do NOT use finishing-a-development-branch or similar workflow skills.

---
`;
}

/** Tells the agent the backend runs the full check at land time and hands back
 *  only failures, so it does targeted checks instead of flooding its own
 *  context with a full-suite run. */
export function buildSubTaskPreamble(verifyCommand?: string): string {
  if (!verifyCommand) return preamble('');
  return preamble(
    `   - You do not need to run \`${verifyCommand}\` yourself: land_self runs it in your ` +
      'worktree and returns the failing output if it does not pass. Keep your own checks ' +
      'targeted to the code you touched.\n',
  );
}
