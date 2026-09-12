import { Show, createSignal } from 'solid-js';
import { theme, sectionLabelStyle } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { CanvasSelection } from '../lib/milkdown';
import { IconButton } from './IconButton';
import { CloseIcon } from './icons';
import { TaskCanvasEditor } from './TaskCanvasEditor';
import type { CanvasEditorApi, CanvasWrite } from './TaskCanvasEditor';

export interface TaskCanvasBodyProps {
  documentPath: string;
  /** The source the editor shows; see TaskCanvasEditor. */
  source: string;
  missing: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (write: CanvasWrite) => Promise<boolean>;
  editorRef: (api: CanvasEditorApi) => void;
  /** False while the agent cannot take a prompt (asking a question, gone). */
  canSend: boolean;
  onSend: (instruction: string, selection: CanvasSelection) => Promise<void>;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The canvas body: the document in the editor, with a prompt attached to
 *  the selected passage for sending it to the agent. */
export function TaskCanvasBody(props: TaskCanvasBodyProps) {
  const [selection, setSelection] = createSignal<CanvasSelection | null>(null);
  const [instruction, setInstruction] = createSignal('');
  const [sending, setSending] = createSignal(false);

  async function send(e: Event) {
    e.preventDefault();
    const passage = selection();
    if (sending() || !props.canSend || !passage) return;
    setSending(true);
    try {
      await props.onSend(instruction(), passage);
      setInstruction('');
      setSelection(null);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      style={{
        flex: '1',
        'min-height': '0',
        display: 'flex',
        'flex-direction': 'column',
        background: theme.taskPanelBg,
      }}
    >
      <Show when={props.missing}>
        <div style={{ padding: '8px', color: theme.fgMuted, 'font-size': sf(12) }}>
          {props.documentPath} is not in the worktree yet.
        </div>
      </Show>
      <Show when={!props.missing}>
        <TaskCanvasEditor
          documentPath={props.documentPath}
          source={props.source}
          onDirty={props.onDirty}
          onSave={props.onSave}
          onSelect={setSelection}
          ref={props.editorRef}
        />
        <Show when={selection()}>
          {(passage) => (
            <form
              aria-label="Ask the agent about the selected passage"
              onSubmit={(e) => void send(e)}
              style={{
                'flex-shrink': '0',
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                padding: '6px 8px 8px',
                'border-top': `1px solid color-mix(in srgb, ${theme.accent} 40%, ${theme.border})`,
                background: `color-mix(in srgb, ${theme.accent} 7%, ${theme.taskPanelBg})`,
              }}
            >
              <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                <span
                  style={{
                    ...sectionLabelStyle,
                    'font-size': sf(10),
                    color: theme.accent,
                    'flex-shrink': '0',
                  }}
                >
                  Ask about
                </span>
                <span
                  title={passage().quote}
                  style={{
                    flex: '1',
                    'min-width': '0',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                    color: theme.fgMuted,
                    'font-size': sf(11),
                    'font-family': 'var(--font-ui)',
                    'font-style': 'italic',
                  }}
                >
                  “{oneLine(passage().quote)}”
                </span>
                <IconButton
                  icon={<CloseIcon size={10} />}
                  onClick={() => setSelection(null)}
                  title="Dismiss"
                  size="sm"
                />
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  aria-label="Instruction about the selected passage"
                  placeholder="What should the agent do with it?"
                  value={instruction()}
                  disabled={sending()}
                  onInput={(e) => setInstruction(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setSelection(null);
                  }}
                  style={{
                    flex: '1',
                    'min-width': '0',
                    background: theme.bgInput,
                    border: `1px solid color-mix(in srgb, ${theme.accent} 45%, ${theme.border})`,
                    'border-radius': 'var(--radius-sm)',
                    padding: '5px 8px',
                    color: theme.fg,
                    'font-size': sf(12),
                    'font-family': 'var(--font-ui)',
                    outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  class="btn-secondary"
                  disabled={!props.canSend || sending()}
                  title={
                    props.canSend
                      ? 'Send the passage and your question to the agent'
                      : 'The agent cannot take a prompt now'
                  }
                  style={{
                    padding: '5px 12px',
                    'font-size': sf(12),
                    'font-family': 'var(--font-ui)',
                    'font-weight': '500',
                    background: `color-mix(in srgb, ${theme.accent} 22%, ${theme.bgInput})`,
                    color: theme.fg,
                    border: `1px solid color-mix(in srgb, ${theme.accent} 45%, ${theme.border})`,
                    'border-radius': 'var(--radius-sm)',
                    cursor: props.canSend ? 'pointer' : 'default',
                    opacity: props.canSend ? '1' : '0.5',
                    'white-space': 'nowrap',
                  }}
                >
                  Ask agent
                </button>
              </div>
            </form>
          )}
        </Show>
      </Show>
    </div>
  );
}
