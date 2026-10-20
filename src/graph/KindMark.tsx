import { Show } from 'solid-js';

/**
 * Type symbol for a note. Evidence draws an outlined document so it reads the same in cards,
 * headings and legends; the text glyph for it renders as a solid block in most fonts.
 */
export function KindMark(props: { kind?: string; mark: string; size?: number }) {
  const size = () => props.size ?? 14;
  return (
    <Show when={props.kind === 'observation'} fallback={props.mark}>
      <svg
        width={size()}
        height={size() * (8 / 7)}
        viewBox="0 0 16 18"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        aria-hidden="true"
      >
        <path
          d="M3 1h7l3 3v13H3zM10 1v3h3M5.5 7h5M5.5 10h5M5.5 13h3"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </Show>
  );
}
