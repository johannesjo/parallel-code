import { Show } from 'solid-js';
import { EvidenceNoteIcon } from '../components/icons';

/**
 * Type symbol for a note. Evidence draws an outlined document so it reads the same in cards,
 * headings and legends; the text glyph for it renders as a solid block in most fonts.
 */
export function KindMark(props: { kind?: string; mark: string; size?: number }) {
  return (
    <Show when={props.kind === 'observation'} fallback={props.mark}>
      <EvidenceNoteIcon size={props.size} />
    </Show>
  );
}
