import { Show, createUniqueId } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { parseGitHubUrl } from '../lib/github-url';
import { invoke } from '../lib/ipc';
import { bannerStyle, linkButtonStyle, theme } from '../lib/theme';
import { ConfirmDialog } from './ConfirmDialog';
import { messageFieldStyle } from './MergeSection';
import { createPrState, type CreatePrStateProps } from './create-pr-state';
import { GitPullRequestIcon, UploadIcon } from './icons';
import { PrDraftButton } from './PrDraftButton';

interface CreatePrDialogProps extends CreatePrStateProps {
  onClose: () => void;
}

const fieldLabel = { 'font-size': '12px', color: theme.fgMuted } as const;
function prNumber(url: string): string {
  return String(parseGitHubUrl(url)?.number ?? '');
}

/**
 * Opens a pull request for the task from Finish: a title, a Markdown
 * description the user writes or drafts, and the base. An unpushed branch is
 * pushed first. Closing keeps a running create going; Finish reports it.
 */
export function CreatePrDialog(props: CreatePrDialogProps) {
  const s = createPrState(props);
  const bodyLabelId = createUniqueId();
  const busy = () => !!s.stage();
  const existing = () => s.existingUrl();
  const footerNote = () => {
    const branch = props.task.branchName;
    if (s.stage() === 'push') return `Pushing ${branch}… Closing keeps it running.`;
    if (s.stage() === 'create') return 'Creating pull request… Closing keeps it running.';
    if (s.unavailable()) return s.unavailable();
    if (existing()) return undefined;
    if (props.remote === 'unpushed') return `${branch} is not on GitHub yet; it is pushed first.`;
    if (props.remote === 'differs') return 'Pushes your latest commits first.';
    return undefined;
  };
  const draftingNote = () => {
    const from = s.drafting.drafting();
    if (!from)
      return "Write a description, or draft one from the task's prompts, commits and diff.";
    if (from === 'agent')
      return `${s.drafting.agentName()} is drafting in its session. Typing here takes over.`;
    return `${s.drafting.sourceLabel(from)} is drafting from the task's prompts, commits and diff. Typing stops it.`;
  };
  const confirmLabel = () => {
    const url = existing();
    if (url) return `Use PR #${prNumber(url)} for this task`;
    return s.needsPush() ? 'Push and create PR' : 'Create PR';
  };
  const confirm = () => {
    if (existing()) s.useExisting();
    else void s.submit();
  };

  return (
    <ConfirmDialog
      open={props.open}
      title="Create pull request"
      width="560px"
      autoFocusCancel={false}
      message={
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
          <div style={{ 'font-size': '13px' }}>
            <code>{props.task.branchName}</code> into <code>{props.base}</code>
          </div>
          <Show when={existing()}>
            {(url) => (
              <div role="status" style={{ ...bannerStyle(theme.fg), 'font-size': '13px' }}>
                This branch already has pull request #{prNumber(url())}.{' '}
                <button
                  type="button"
                  style={linkButtonStyle}
                  onClick={() => void invoke(IPC.ShellOpenExternal, { url: url() })}
                >
                  Open on GitHub
                </button>
              </div>
            )}
          </Show>
          <label style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <span style={fieldLabel}>Title</span>
            <input
              type="text"
              value={s.title()}
              disabled={busy() || !!existing()}
              onInput={(e) => s.editTitle(e.currentTarget.value)}
              style={{ ...messageFieldStyle, 'font-family': 'inherit' }}
            />
          </label>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <span id={bodyLabelId} style={{ ...fieldLabel, flex: '1' }}>
                Description · Markdown
              </span>
              <PrDraftButton
                drafting={s.drafting}
                hasBody={!!s.body().trim()}
                hasAgent={!!props.task.agentIds[0]}
                // Reopening the dialog starts over, so a draft made now would be lost.
                disabled={busy() || !!existing() || !!s.unavailable()}
              />
            </div>
            <textarea
              aria-labelledby={bodyLabelId}
              value={s.body()}
              disabled={busy() || !!existing()}
              rows={12}
              placeholder={draftingNote()}
              onInput={(e) => s.editBody(e.currentTarget.value)}
              style={{ ...messageFieldStyle, resize: 'vertical' }}
            />
            {/* Reserved, so a failed draft does not move the fields below. */}
            <p
              role="status"
              style={{
                margin: '0',
                'min-height': '18px',
                'font-size': '12px',
                color: theme.fgMuted,
                visibility: s.drafting.error() ? 'visible' : 'hidden',
              }}
            >
              Could not draft: {s.drafting.error()}{' '}
              <button type="button" style={linkButtonStyle} onClick={() => s.drafting.start()}>
                Retry
              </button>
            </p>
          </div>
          <label style={{ display: 'flex', 'align-items': 'center', gap: '8px', color: theme.fg }}>
            <input
              type="checkbox"
              checked={s.draft()}
              disabled={busy() || !!existing()}
              onChange={(e) => s.setDraft(e.currentTarget.checked)}
            />
            Create as draft
          </label>
          <Show when={s.error()}>
            <div role="alert" style={{ ...bannerStyle(theme.error), 'font-size': '13px' }}>
              {s.error()} Your description is kept.
            </div>
          </Show>
        </div>
      }
      footerNote={footerNote()}
      confirmLabel={confirmLabel()}
      confirmIcon={
        s.needsPush() && !existing() ? <UploadIcon size={14} /> : <GitPullRequestIcon size={14} />
      }
      confirmLoading={busy()}
      confirmDisabled={busy() || !!s.unavailable() || (!existing() && !s.title().trim())}
      cancelLabel={busy() ? 'Close' : 'Back to Finish'}
      onConfirm={confirm}
      onCancel={() => props.onClose()}
    />
  );
}
