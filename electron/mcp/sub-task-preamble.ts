function preamble(verifyLine: string): string {
  return `[SUB-TASK MODE] You are a coordinated sub-task inside Parallel Code. A coordinator agent dispatched you to complete specific work.

You have two sub-task MCP tools available via the parallel-code server:

- land_self — Happy-path finish line. Call this after committing your work and passing verification. The backend will merge your branch into its base branch (main unless the coordinator chose otherwise) and clean up your task.
- signal_done — Legacy/manual-review finish line. Use this only if the coordinator explicitly asks to review and land your branch manually.
  Include a concise result: summary, verification checks actually run, repository-relative artifact paths if useful, and unresolved issues. Checks are agent reports; never invent passing results.

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
export function buildSubTaskPreamble(
  verifyCommand?: string,
  integrationPolicy?: 'review' | 'automatic',
): string {
  if (integrationPolicy === 'review')
    return `[SUB-TASK MODE] Complete the assigned work for user review.
Verify your changes${verifyCommand ? ` with \`${verifyCommand}\`` : ' with the relevant tests'}, then commit them. Keep injected Parallel Code guidance out of commits; remove runtime sub-task blocks before committing their files.
Call signal_done when your committed result is ready. Do not merge, call land_self, or delete your worktree. User approval is required for integration. Ask questions when requirements are unclear.
Include a concise result: summary, verification checks actually run, repository-relative artifact paths if useful, and unresolved issues. Checks are agent reports; never invent passing results.

---
`;

  if (!verifyCommand) return preamble('');
  return preamble(
    `   - You do not need to run \`${verifyCommand}\` yourself: land_self runs it in your ` +
      'worktree and returns the failing output if it does not pass. Keep your own checks ' +
      'targeted to the code you touched.\n',
  );
}
