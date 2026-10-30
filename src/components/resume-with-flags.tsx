import { Show, createSignal, type JSX } from 'solid-js';
import { ConfirmDialog } from './ConfirmDialog';
import { store } from '../store/core';
import { resumeAgentWithFlags } from '../store/agents';
import { theme } from '../lib/theme';

// shortcut: whitespace split, like the custom agent editor — no quoted values
// with spaces; add shell-style parsing if a flag ever needs one.
function parseFlags(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * "Resume with flags…": relaunches an agent pane with extra CLI flags, keeping
 * its conversation. `open` shows the dialog, pre-filled with the pane's flags.
 */
export function createResumeWithFlags(agentId: () => string): {
  open: () => void;
  Dialog: () => JSX.Element;
} {
  const [draft, setDraft] = createSignal<string | null>(null);
  const agent = () => store.agents[agentId()];

  const submit = () => {
    const text = draft();
    setDraft(null);
    if (text !== null) resumeAgentWithFlags(agentId(), parseFlags(text));
  };

  const Dialog = () => (
    <Show when={draft() !== null}>
      <ConfirmDialog
        open
        title={`Resume ${agent()?.def.name ?? 'agent'} with flags`}
        autoFocusCancel={false}
        confirmLabel="Resume"
        onConfirm={submit}
        onCancel={() => setDraft(null)}
        message={
          <label style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
            <span>
              {agent()?.def.resume_args?.length
                ? 'Restarts the agent and continues its conversation with these flags, for example --chrome.'
                : 'This agent cannot resume, so it starts a new conversation with these flags.'}{' '}
              Work in progress stops. The flags stay for later launches of this pane; clear the
              field to remove them.
            </span>
            <input
              type="text"
              aria-label="Extra flags"
              placeholder="space-separated flags"
              value={draft() ?? ''}
              ref={(el) => requestAnimationFrame(() => el.focus())}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              style={{
                padding: '8px 10px',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-sm)',
                color: theme.fg,
                'font-size': '13px',
                'font-family': "'JetBrains Mono', monospace",
                width: '100%',
                'box-sizing': 'border-box',
              }}
            />
          </label>
        }
      />
    </Show>
  );

  return { open: () => setDraft((agent()?.def.extra_args ?? []).join(' ')), Dialog };
}
