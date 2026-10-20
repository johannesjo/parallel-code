import { createSignal, For, onMount, Show, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import { CopyIcon, EyeIcon, SendIcon } from './icons';
import { DocumentIcon } from '../documents/DocumentIcon';

/** Selection text is captured before opening, so focus changes cannot alter the handoff. */
export function TerminalSelectionMenu(props: {
  x: number;
  y: number;
  text: string;
  recipients: { id: string; label: string }[];
  onSend: (text: string, recipientAgentId?: string) => void;
  onOpinion?: () => void;
  /** The Markdown or HTML path right-clicked, when there was one. */
  documentPath?: string;
  onEditAsDocument?: (filePath: string) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  let menu: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal(untrack(() => ({ x: props.x, y: props.y })));
  const [error, setError] = createSignal('');
  onMount(() => {
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(4, Math.min(props.x, window.innerWidth - bounds.width - 4)),
      y: Math.max(4, Math.min(props.y, window.innerHeight - bounds.height - 4)),
    });
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  });
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      props.onClose();
    } catch {
      setError('Could not copy. Try your keyboard copy shortcut.');
    }
  }
  function send(id?: string) {
    props.onSend(props.text, id);
    props.onClose(false);
  }
  return (
    <Portal>
      <div
        class="terminal-selection-backdrop"
        onPointerDown={() => props.onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onClose();
        }}
      />
      <div
        ref={menu}
        class="terminal-selection-menu"
        role="menu"
        aria-label="Terminal actions"
        style={{ left: `${position().x}px`, top: `${position().y}px` }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') {
            if (e.key === 'Escape') e.preventDefault();
            e.stopPropagation();
            props.onClose();
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            const buttons = [...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const index =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? buttons.length - 1
                  : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[index]?.focus();
          }
        }}
      >
        <Show when={props.documentPath}>
          {(path) => (
            <button
              role="menuitem"
              title={`Edit ${path()} as a document (nothing is committed here)`}
              onClick={() => {
                props.onEditAsDocument?.(path());
                props.onClose(false);
              }}
            >
              <DocumentIcon size={14} />
              Edit as document
            </button>
          )}
        </Show>
        <Show when={props.text}>
          <button role="menuitem" onClick={() => void copy()}>
            <CopyIcon size={14} />
            Copy
          </button>
          <For each={props.recipients}>
            {(recipient) => (
              <button role="menuitem" onClick={() => send(recipient.id)}>
                <SendIcon size={14} />
                Send to {recipient.label}…
              </button>
            )}
          </For>
          <Show when={!props.recipients.length}>
            <button role="menuitem" onClick={() => send()}>
              <EyeIcon size={14} />
              Ask another agent…
            </button>
          </Show>
        </Show>
        <Show when={props.onOpinion}>
          <button
            role="menuitem"
            onClick={() => {
              props.onOpinion?.();
              props.onClose(false);
            }}
          >
            <EyeIcon size={14} />
            Second opinion…
          </button>
        </Show>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </div>
    </Portal>
  );
}
