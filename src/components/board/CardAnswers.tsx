import { createSignal, For } from 'solid-js';
import type { PromptMenu, PromptMenuOption } from '../../../electron/shared/prompt-menu';
import { warn as logWarn } from '../../lib/log';
import { pickPromptOption } from '../../store/promptPeek';

/** The dialog's text without its blank lines, for the card; the peek shows it whole. */
export function questionText(menu: PromptMenu): string {
  return menu.body.filter(Boolean).join('\n');
}

/** Options that ask for typing open the peek, so their button says so. */
export function answerLabel(option: PromptMenuOption): string {
  if (!option.typed) return option.label;
  return /^no\b/i.test(option.label) ? 'No…' : 'Reply…';
}

/**
 * The agent's choices on a Needs-you card. A choice is typed into the agent
 * only if the same dialog is still on screen; options that need a typed answer
 * open the peek instead.
 */
export function CardAnswers(props: {
  target: { taskId: string; agentId: string };
  menu: PromptMenu;
  onReply: (anchor: HTMLElement) => void;
}) {
  // One answer per dialog read: until the agent redraws, a second press would
  // still match and its key would land in whatever comes next.
  const [answered, setAnswered] = createSignal<PromptMenu | null>(null);
  const done = () => answered() === props.menu;
  // A dialog that changed in the meantime takes no key; the next read redraws the buttons.
  const pick = (option: PromptMenuOption, button: HTMLElement) => {
    if (done()) return;
    if (option.typed) return props.onReply(button);
    const menu = props.menu;
    setAnswered(menu);
    pickPromptOption(props.target, menu, option).then(
      (sent) => sent || setAnswered(null),
      (err: unknown) => {
        setAnswered(null);
        logWarn('card-answers', 'answer failed', { err });
      },
    );
  };
  return (
    <div class="task-board-ask task-board-answers">
      <For each={props.menu.options}>
        {(option, i) => (
          <button
            type="button"
            class="task-board-act"
            classList={{ primary: i() === 0 }}
            data-answer={option.n}
            title={[option.label, option.detail].filter(Boolean).join('\n')}
            aria-keyshortcuts={String(option.n)}
            disabled={done()}
            onClick={(event) => pick(option, event.currentTarget)}
          >
            <span class="task-board-answer-n" aria-hidden="true">
              {option.n}
            </span>
            <span class="task-board-answer-label">{answerLabel(option)}</span>
          </button>
        )}
      </For>
    </div>
  );
}
