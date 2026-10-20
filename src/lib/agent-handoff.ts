import type { AgentDef } from '../ipc/types';
import type { GitIsolationMode } from '../store/types';
import { getTaskDiffBaseBranch } from './load-task-diff';
import { isEffortArg, isModelArg } from './agent-args';

const REVIEW_ASK =
  'Report defects with file locations, impact and evidence; list optional suggestions separately. ' +
  "Don't modify files.";

/**
 * The editable text a second opinion starts from. The reviewer shares the
 * worktree, so the text says where the changes are instead of embedding them,
 * and it is sent exactly as the user leaves it.
 */
export function secondOpinionText(input: {
  gitIsolation: GitIsolationMode;
  baseBranch?: string;
  taskPrompt?: string;
  selection?: { agent: string; text: string };
}): string {
  if (input.selection)
    return `Please check this and suggest concrete improvements.\n\nOutput from ${input.selection.agent}:\n${input.selection.text}`;
  // Matches the task diff viewer: everything since the merge-base, plus new files.
  const base = getTaskDiffBaseBranch(input.gitIsolation, input.baseBranch);
  const changes =
    input.gitIsolation === 'none'
      ? 'Review the work in this folder.'
      : base
        ? `Review the changes on this branch since it split from ${base}, including uncommitted and new files (\`git diff $(git merge-base ${base} HEAD)\`, \`git status\`).`
        : 'Review the changes on this branch since it split from the default branch, including uncommitted and new files.';
  const task = input.taskPrompt?.trim();
  return task
    ? `${changes} Check them against the task below. ${REVIEW_ASK}\n\nTask:\n${task}`
    : `${changes} ${REVIEW_ASK}`;
}

/**
 * Strip controls that could end the bracketed paste early and run the rest as
 * keystrokes, and invisible characters that would hide text from the reader.
 * Peer message markers, which the queue rejects so a body cannot fake one, get
 * a visible dot ("peer·message").
 */
export function cleanHandoffText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
      '',
    )
    .replace(/((?:begin|end)[\s_-]*peer)[\s_-]*(message)/gi, '$1·$2');
}

function effortArgs(command: string | undefined, effort: string): string[] {
  if (command === 'claude') return ['--effort', effort];
  return command === 'codex' ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [];
}

/**
 * Override model and reasoning flags for this reviewer only; retain other
 * launch and resume settings. Only Claude Code and Codex take a reasoning level.
 */
export function reviewerWithModel(def: AgentDef, model: string, effort = ''): AgentDef {
  const command = def.command.split('/').pop();
  const efforts = effort ? effortArgs(command, effort) : [];
  if (!model && efforts.length === 0) return def;
  // Only flags being replaced go; no level keeps one configured on the agent.
  const replace = (args: string[]) => [
    ...args.filter(
      (_, index) =>
        !(model && isModelArg(args, index)) && !(efforts.length && isEffortArg(args, index)),
    ),
    ...(model ? ['--model', model] : []),
    ...efforts,
  ];
  // Normalize bare automatic-resume defaults before adding overrides: otherwise
  // the launcher's exact default check could resume a different pane's session.
  const resume = def.resume_args.join(' ');
  const resumeArgs =
    command === 'codex' && resume === 'resume --last'
      ? ['resume']
      : command === 'claude' && resume === '--continue'
        ? ['--resume']
        : def.resume_args;
  return { ...def, args: replace(def.args), resume_args: replace(resumeArgs) };
}
