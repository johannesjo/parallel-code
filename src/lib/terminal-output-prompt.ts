/**
 * Wraps a terminal's output for an agent prompt. The fence is longer than any
 * backtick run in the output, so output containing Markdown can't close it early.
 */
export function terminalOutputPrompt(output: string): string {
  const longest = Math.max(0, ...(output.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `Terminal output:\n${fence}\n${output}\n${fence}`;
}
