import { Show, createEffect, createSignal, createUniqueId, on, type JSX } from 'solid-js';
import { VERIFY_CHECK_ID } from '../../electron/shared/evidence';
import { theme } from '../lib/theme';
import {
  buildEvidence,
  getEvidenceUiState,
  getTaskChecks,
  isEvidenceBusy,
  runTaskVerification,
} from '../store/store';
import type { Task } from '../store/types';
import { evidenceButtonStyle } from './EvidenceDetails';
import { PlayIcon } from './icons';

interface ReadinessSectionProps {
  task: Task;
  children: JSX.Element;
}

const toggleStyle = {
  background: 'none',
  border: 'none',
  padding: '8px 0',
  color: theme.fgMuted,
  cursor: 'pointer',
  'font-size': '13px',
};

/**
 * Folded until evidence was built or a check ran, with those two actions in the
 * header so they stay reachable. After that it folds only on a click, never on
 * a status change.
 */
export function ReadinessSection(props: ReadinessSectionProps) {
  const hasResults = () => Boolean(props.task.evidence || props.task.verificationRun);
  const [open, setOpen] = createSignal(false);
  // Opens at mount, or when auto-evidence or an agent's check lands while the
  // dialog is up, so a failure it reports is not left folded away.
  createEffect(
    on(hasResults, (has, had) => {
      if (has && !had) setOpen(true);
    }),
  );
  const verifyCommand = () =>
    getTaskChecks(props.task.id).find((check) => check.id === VERIFY_CHECK_ID)?.command;
  const bodyId = createUniqueId();
  // Both actions cancel and restart work in flight, so offer them only when idle.
  const busy = () => {
    const pkg = props.task.evidence;
    return (
      Boolean(getEvidenceUiState(props.task.id).scanning) ||
      Boolean(pkg && isEvidenceBusy(pkg)) ||
      props.task.verificationRun?.status === 'running'
    );
  };
  const build = () => {
    setOpen(true);
    void buildEvidence(props.task.id, { trigger: 'manual' });
  };
  const runVerify = () => {
    setOpen(true);
    void runTaskVerification(props.task.id);
  };

  return (
    <section aria-label="Readiness and checks" style={{ margin: '28px 0', 'font-size': '13px' }}>
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
        <button
          type="button"
          aria-expanded={open()}
          aria-controls={bodyId}
          style={toggleStyle}
          onClick={() => setOpen(!open())}
        >
          <span aria-hidden="true">{open() ? '▾' : '▸'}</span> Readiness and checks
        </button>
        <Show when={!open() && !busy()}>
          <button type="button" style={evidenceButtonStyle} onClick={build}>
            Build evidence
          </button>
          <Show when={verifyCommand()}>
            {(command) => (
              <button
                class="btn-with-icon"
                type="button"
                style={evidenceButtonStyle}
                title={`Run ${command()} in the task worktree`}
                onClick={runVerify}
              >
                <PlayIcon size={12} />
                Run
              </button>
            )}
          </Show>
        </Show>
      </div>
      {/* Hidden rather than unmounted, so folding keeps the panel's local state. */}
      <div id={bodyId} hidden={!open()} style={{ 'margin-top': '8px' }}>
        {props.children}
      </div>
    </section>
  );
}
