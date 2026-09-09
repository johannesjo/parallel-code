import { For, Show, createMemo, type JSX } from 'solid-js';
import { store, pickAndAddProject, toggleNewTaskDialog } from '../store/store';
import { codeProjects } from '../store/projects';
import { setNewTaskPrefillPrompt } from '../store/tasks';
import { theme } from '../lib/theme';
import { mod } from '../lib/platform';
import { FolderIcon } from './icons';
import { FIRST_TASK_SUGGESTIONS, detectedAgentsLine } from './first-run';

const kbdStyle: JSX.CSSProperties = {
  background: theme.bgElevated,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-xs)',
  padding: '2px 6px',
  'font-family': "'JetBrains Mono', monospace",
  'font-size': '12px',
};

const titleStyle: JSX.CSSProperties = {
  'font-size': '18px',
  color: theme.fg,
  'font-weight': '600',
  'margin-bottom': '4px',
  'letter-spacing': '-0.01em',
};

function Step(props: { n: number; title: string; detail: string | null }) {
  return (
    <li style={{ display: 'flex', gap: '12px', 'align-items': 'flex-start' }}>
      <span
        aria-hidden="true"
        style={{
          width: '22px',
          height: '22px',
          'border-radius': '50%',
          background: `color-mix(in srgb, ${theme.accent} 18%, transparent)`,
          color: theme.accent,
          'font-size': '12px',
          'font-weight': '600',
          display: 'inline-flex',
          'align-items': 'center',
          'justify-content': 'center',
          'flex-shrink': '0',
        }}
      >
        {props.n}
      </span>
      <span>
        <div style={{ color: theme.fg, 'font-size': '14px', 'font-weight': '500' }}>
          {props.title}
        </div>
        <Show when={props.detail}>
          <div style={{ color: theme.fgSubtle, 'font-size': '12px', 'margin-top': '2px' }}>
            {props.detail}
          </div>
        </Show>
      </span>
    </li>
  );
}

/** Empty state before any project is linked: the three-step promise plus the
 *  one button that starts it. */
function LinkProjectSteps() {
  const agentsLine = createMemo(() => detectedAgentsLine(store.availableAgents));
  return (
    <>
      <div style={{ 'text-align': 'center' }}>
        <div style={titleStyle}>Dispatch your first agent</div>
        <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
          Three steps from an empty window to a reviewable diff
        </div>
      </div>
      <ol
        style={{
          'list-style': 'none',
          padding: '0',
          margin: '4px 0 0',
          display: 'flex',
          'flex-direction': 'column',
          gap: '14px',
          'max-width': '420px',
          'text-align': 'left',
        }}
      >
        <Step n={1} title="Link a git repository" detail="Any local folder with your code" />
        <Step n={2} title="Pick an agent" detail={agentsLine()} />
        <Step
          n={3}
          title="Describe the task"
          detail="It runs on its own branch in its own worktree. Review the diff, merge it, or toss it."
        />
      </ol>
      <button
        class="btn-primary"
        onClick={() => pickAndAddProject()}
        style={{
          'margin-top': '8px',
          padding: '9px 20px',
          background: theme.accent,
          border: 'none',
          'border-radius': 'var(--radius-md)',
          color: theme.accentText,
          cursor: 'pointer',
          'font-size': '14px',
          'font-weight': '500',
          display: 'inline-flex',
          'align-items': 'center',
          gap: '6px',
        }}
      >
        <FolderIcon size={14} />
        Link Project
      </button>
    </>
  );
}

function startSuggestedTask(suggestion: { name: string; prompt: string }): void {
  const projects = codeProjects();
  const projectId = projects.find((p) => p.id === store.lastProjectId)?.id ?? projects[0]?.id;
  setNewTaskPrefillPrompt(suggestion.prompt, projectId ?? null, suggestion.name);
  toggleNewTaskDialog(true);
}

/** Empty state once a project exists: suggested first prompts that open the
 *  new-task dialog pre-filled, so the first dispatch is one click. */
function FirstTaskSuggestions() {
  return (
    <>
      <div style={{ 'text-align': 'center' }}>
        <div style={titleStyle}>No tasks yet</div>
        <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
          Press <kbd style={kbdStyle}>{mod}+N</kbd> to describe one, or start with a suggestion
        </div>
      </div>
      <ul
        aria-label="Suggested first tasks"
        style={{
          'list-style': 'none',
          padding: '0',
          margin: '0',
          display: 'flex',
          gap: '8px',
          'flex-wrap': 'wrap',
          'justify-content': 'center',
        }}
      >
        <For each={FIRST_TASK_SUGGESTIONS}>
          {(s) => (
            <li>
              <button
                class="first-run-suggestion"
                title={s.prompt}
                onClick={() => startSuggestedTask(s)}
              >
                {s.name}
              </button>
            </li>
          )}
        </For>
      </ul>
    </>
  );
}

export function FirstRunGuide() {
  return (
    <Show when={codeProjects().length > 0} fallback={<LinkProjectSteps />}>
      <FirstTaskSuggestions />
    </Show>
  );
}
