import { Show, children, splitProps, type JSX } from 'solid-js';

type SectionProps = Omit<JSX.HTMLAttributes<HTMLElement>, 'class' | 'title' | 'children'>;

/**
 * A board lane: a titled column of cards with no box of its own. `tools`
 * overlay the end of the title row, so showing them never moves it;
 * `children` are the lane's `<li>` cards, `before`/`after` anything around
 * the list.
 */
export function BoardLane(
  props: SectionProps & {
    class?: string;
    headingId?: string;
    title: JSX.Element;
    count: JSX.Element;
    tools?: JSX.Element;
    before?: JSX.Element;
    after?: JSX.Element;
    listLabel?: string;
    children: JSX.Element;
  },
) {
  const [own, section] = splitProps(props, [
    'class',
    'headingId',
    'title',
    'count',
    'tools',
    'before',
    'after',
    'listLabel',
    'children',
  ]);
  // Resolved once: reading a JSX prop twice would build its elements twice.
  const tools = children(() => own.tools);
  return (
    <section {...section} class={`task-board-lane ${own.class ?? ''}`}>
      <h3 id={own.headingId} class="task-board-lane-title">
        {own.title}
        <span class="task-board-count">{own.count}</span>
      </h3>
      <Show when={tools()}>
        <div class="task-board-lane-tools">{tools()}</div>
      </Show>
      {own.before}
      <ol class="task-board-cards" aria-label={own.listLabel}>
        {own.children}
      </ol>
      {own.after}
    </section>
  );
}

type RailProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'children'>;

/** A lane folded to a narrow rail; clicking it opens the lane. */
export function BoardRail(props: RailProps & { label: string; count: JSX.Element }) {
  const [own, button] = splitProps(props, ['label', 'count']);
  return (
    <button type="button" {...button} class="task-board-rail">
      <span class="task-board-rail-title">{own.label}</span>
      <span class="task-board-count">{own.count}</span>
    </button>
  );
}
