import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on } from 'solid-js';
import type { ChatCommand } from '../../../electron/shared/agent-chat-types';

/**
 * The command name being typed, while the draft is a lone `/word` or `$word`. The agent runs
 * a command only from the start of a message, so completion opens only there.
 */
function commandQuery(draft: string): string | undefined {
  return /^[/$](\S*)$/.exec(draft)?.[1];
}

/** Names, or a plugin skill's own name after its `plugin:`, starting with the query;
 *  an exact name first, so Enter on a fully typed command sends that command. */
function matchCommands(commands: ChatCommand[], query: string): ChatCommand[] {
  const needle = query.toLocaleLowerCase();
  const name = (command: ChatCommand) => command.name.toLocaleLowerCase();
  // Prefixes only: a path such as /src/app.ts should not turn Enter into a completion.
  return commands
    .filter((command) => name(command).startsWith(needle) || name(command).includes(`:${needle}`))
    .sort((a, b) => Number(name(b) === needle) - Number(name(a) === needle));
}

/** Terminal-style completion for slash commands and skills in the composer. */
export function createCommandComplete(input: {
  commands: () => ChatCommand[] | undefined;
  draft: () => string;
  onDraft: (text: string) => void;
}) {
  const id = createUniqueId();
  const [active, setActive] = createSignal(0);
  // The draft the user dismissed the list on; typing on brings it back.
  const [dismissed, setDismissed] = createSignal<string>();
  const matches = createMemo(() => {
    const query = commandQuery(input.draft());
    if (query === undefined || input.draft() === dismissed()) return [];
    return matchCommands(
      (input.commands() ?? []).filter(
        (command) => !input.draft().startsWith('$') || command.prefix === '$',
      ),
      query,
    );
  });
  createEffect(on(matches, () => setActive(0)));
  createEffect(on(input.draft, (draft) => draft !== dismissed() && setDismissed(undefined)));
  const optionId = (index: number) => `${id}-${index}`;

  // A new draft value moves the caret to the end, which is where an argument goes.
  const choose = (command: ChatCommand) =>
    input.onDraft(`${command.prefix ?? '/'}${command.name} `);

  /** Handles a key while the list is open; true when the key was used. */
  function onKeyDown(event: KeyboardEvent): boolean {
    const list = matches();
    if (!list.length || event.isComposing) return false;
    const command = list[active()] ?? list[0];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active() + step + list.length) % list.length);
      document.getElementById(optionId(active()))?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Escape') setDismissed(input.draft());
    else if (
      event.key === 'Tab' &&
      !(event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
    )
      choose(command);
    // A command typed out in full sends, as it would in a terminal.
    else if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      input.draft() !== `${command.prefix ?? '/'}${command.name}`
    )
      choose(command);
    else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  return {
    listId: id,
    matches,
    active,
    optionId,
    choose,
    /** Keeps the list closed for this draft, e.g. a recalled message that starts with `/`. */
    dismiss: (draft: string) => setDismissed(draft),
    activeId: () => (matches().length ? optionId(active()) : undefined),
    onKeyDown,
  };
}

type CommandComplete = ReturnType<typeof createCommandComplete>;

/** The completions, above the message box like a shell's suggestion list. */
export function CommandList(props: { complete: CommandComplete }) {
  return (
    <Show when={props.complete.matches().length}>
      <ul id={props.complete.listId} role="listbox" aria-label="Commands" class="chat-command-list">
        <For each={props.complete.matches()}>
          {(command, index) => (
            <li
              id={props.complete.optionId(index())}
              role="option"
              aria-selected={index() === props.complete.active()}
              // Keep focus in the composer, as a click on the list is a completion.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.complete.choose(command)}
            >
              <span>
                {command.prefix ?? '/'}
                {command.name}
                <Show when={command.argumentHint}> {command.argumentHint}</Show>
              </span>
              <small title={command.description}>{command.description}</small>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
