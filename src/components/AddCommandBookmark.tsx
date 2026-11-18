import { Show, createEffect, createSignal, createUniqueId, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { getProject, updateProject } from '../store/store';
import { BookmarkPlusIcon } from './icons';
import { createAnchorEffect, placeBelow } from '../lib/floating';
import { ProjectField, projectButtonStyle, projectMonoInputStyle } from './ProjectDialogParts';
import { theme } from '../lib/theme';
import { BOOKMARK_NAME_MAX_LENGTH, draftBookmark } from '../lib/bookmarks';

/** Add a project command bookmark straight from the shell toolbar, without opening project settings. */
export function AddCommandBookmark(props: { projectId: string }) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [name, setName] = createSignal('');
  const [url, setUrl] = createSignal('');
  const [position, setPosition] = createSignal({ top: 0, right: 0, maxHeight: 240 });
  let anchor: HTMLButtonElement | undefined;
  let panel: HTMLFormElement | undefined;

  function close(restoreFocus = false) {
    setOpen(false);
    setDraft('');
    setName('');
    setUrl('');
    if (restoreFocus) anchor?.focus();
  }

  createAnchorEffect(open, () => {
    if (!anchor) return;
    setPosition(
      placeBelow(
        anchor.getBoundingClientRect(),
        Math.min(360, window.innerWidth - 24),
        { width: window.innerWidth, height: window.innerHeight },
        12,
        panel?.offsetHeight || 180,
      ),
    );
  });

  createEffect(() => {
    if (!open()) return;
    queueMicrotask(() => {
      if (panel?.isConnected) panel.querySelector('input')?.focus();
    });
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel?.contains(event.target) &&
        !anchor?.contains(event.target)
      )
        close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    });
  });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        class="shell-toolbar-button shell-bookmark-button"
        title="Add command bookmark"
        aria-label="Add command bookmark"
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={open() ? id : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (open()) close();
          else setOpen(true);
        }}
      >
        <BookmarkPlusIcon size={16} />
      </button>
      <Show when={open()}>
        <Portal>
          <form
            ref={panel}
            id={id}
            role="dialog"
            tabIndex={-1}
            aria-label="Add command bookmark"
            onClick={(event) => event.stopPropagation()}
            onFocusOut={(event) => {
              // No related target means the window lost focus (e.g. switching apps to copy a
              // command); keep the draft. Outside clicks are handled by the pointerdown listener.
              const next = event.relatedTarget;
              if (next instanceof Node && !panel?.contains(next) && !anchor?.contains(next))
                close();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              const bookmark = draftBookmark({ command: draft(), name: name(), url: url() });
              const project = getProject(props.projectId);
              if (!bookmark || !project) return;
              const bookmarks = project.terminalBookmarks ?? [];
              // A repeat updates the existing button's name and link instead of adding a twin.
              const existing = bookmarks.find((b) => b.command === bookmark.command);
              const { id: _id, command: _command, ...extras } = bookmark;
              const next = existing
                ? bookmarks.map((b) => (b === existing ? { ...b, ...extras } : b))
                : [...bookmarks, bookmark];
              if (!existing || Object.keys(extras).length > 0) {
                updateProject(props.projectId, { terminalBookmarks: next });
              }
              close(true);
            }}
            style={{
              position: 'fixed',
              top: `${position().top}px`,
              right: `${position().right}px`,
              'max-height': `${position().maxHeight}px`,
              width: 'min(360px, calc(100vw - 24px))',
              'box-sizing': 'border-box',
              overflow: 'auto',
              'z-index': '1000',
              padding: '12px',
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-md)',
              'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.3)',
            }}
          >
            <ProjectField
              label="Command"
              hint="Saved for all tasks in this project; each task runs it in its own terminal."
            >
              {(inputId) => (
                <input
                  id={inputId}
                  class="input-field"
                  type="text"
                  placeholder="e.g. npm run dev -- --port $PARALLEL_CODE_PORT"
                  value={draft()}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  style={projectMonoInputStyle}
                />
              )}
            </ProjectField>
            <div style={{ display: 'flex', gap: '6px', 'margin-top': '8px' }}>
              <input
                class="input-field"
                type="text"
                aria-label="Name (optional)"
                placeholder="Name (optional)"
                maxLength={BOOKMARK_NAME_MAX_LENGTH}
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
                style={{ ...projectMonoInputStyle, width: '110px', 'flex-shrink': '0' }}
              />
              <input
                class="input-field"
                type="text"
                aria-label="Link (optional)"
                title="Opens in the task's browser preview; $PARALLEL_CODE_PORT is the task's port"
                placeholder="Link, e.g. localhost:$PARALLEL_CODE_PORT"
                value={url()}
                onInput={(event) => setUrl(event.currentTarget.value)}
                style={{ ...projectMonoInputStyle, flex: '1', 'min-width': '0' }}
              />
            </div>
            <div
              style={{
                display: 'flex',
                'justify-content': 'flex-end',
                gap: '6px',
                'margin-top': '12px',
              }}
            >
              <button
                type="button"
                class="btn-secondary"
                style={projectButtonStyle}
                onClick={() => close(true)}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn-secondary"
                disabled={!draft().trim()}
                style={{ ...projectButtonStyle, color: theme.fg }}
              >
                Save command
              </button>
            </div>
          </form>
        </Portal>
      </Show>
    </>
  );
}
