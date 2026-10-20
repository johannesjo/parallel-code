import { createSignal } from 'solid-js';

/**
 * `@` at a word start opens the worktree file search. The `@` stays typed until a
 * file is chosen, so a literal mention such as `@Component` costs only an Escape.
 */
export function createFileMention(input: {
  textarea: () => HTMLTextAreaElement | undefined;
  draft: () => string;
  onDraft: (text: string) => void;
  /** The referenced files; a search that adds one consumes its `@`. */
  files: () => string[];
}) {
  // Where the `@` sits in the draft, and the files referenced before the search.
  const [mention, setMention] = createSignal<{ at: number; files: string[] }>();

  function onInput(event: InputEvent & { currentTarget: HTMLTextAreaElement }) {
    const at = event.currentTarget.selectionStart - 1;
    if (event.data !== '@' || /\S/.test(event.currentTarget.value[at - 1] ?? '')) return;
    setMention({ at, files: input.files() });
  }

  function close() {
    const opened = mention();
    if (!opened) return;
    setMention(undefined);
    const draft = input.draft();
    const chosen = input.files().some((file) => !opened.files.includes(file));
    const removed = chosen && draft[opened.at] === '@';
    if (removed) input.onDraft(draft.slice(0, opened.at) + draft.slice(opened.at + 1));
    // A new draft value moves the caret to the end; put it back where the `@` was.
    const caret = removed ? opened.at : opened.at + 1;
    const textarea = input.textarea();
    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  }

  return { open: () => !!mention(), onInput, close };
}
