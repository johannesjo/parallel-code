import { createSignal, untrack } from 'solid-js';
import { tourToMindMap, mindMapToTour } from '../../lib/tour-mindmap';
import type { TourNode } from '../../lib/tour-tree';
import { MindMapEditor } from '../../mindmap/MindMapEditor';

/**
 * The tour as a mind map, the same tree seen whole. It opens on the cards as
 * they are and hands every edit back as cards; the map keeps its own document
 * meanwhile, so its undo history and selection survive each edit.
 */
export function ThinkingMap(props: {
  subject: string;
  roots: TourNode[];
  onChange: (roots: TourNode[]) => void;
}) {
  const [map, setMap] = createSignal(untrack(() => tourToMindMap(props.subject, props.roots)));
  return (
    <div class="thinking-map">
      <MindMapEditor
        document={map()}
        visible
        onChange={(next) => {
          setMap(next);
          props.onChange(mindMapToTour(next, props.roots));
        }}
      />
    </div>
  );
}
