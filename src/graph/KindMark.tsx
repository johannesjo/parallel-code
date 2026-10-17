import { Show } from 'solid-js';
import { DocumentLinesIcon } from '../components/icons';

/**
 * Type symbol for a note. Evidence draws an outlined document so it reads the same in cards,
 * headings and legends; the text glyph for it renders as a solid block in most fonts.
 */
export function KindMark(props: { kind?: string; mark: string; size?: number }) {
  const size = () => props.size ?? 14;
  return (
    <Show when={props.kind === 'observation'} fallback={props.mark}>
      <DocumentLinesIcon size={size()} height={size() * (8 / 7)} />
    </Show>
  );
}
