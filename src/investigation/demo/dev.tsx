import { createSignal } from 'solid-js';
import { MindMapEditor } from '../../mindmap/MindMapEditor';
import { createMindMap } from '../../graph/model';
import { render } from 'solid-js/web';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '../../styles.css';
import { ReasoningGraph } from '../ReasoningGraph';
import { makeFixture } from '../fixture';
import { InvestigationView } from './InvestigationView';

const root = document.getElementById('root');
function MindMapDemo() {
  const [document, setDocument] = createSignal(createMindMap());
  return <MindMapEditor document={document()} onChange={setDocument} visible />;
}
if (import.meta.env.DEV && root)
  render(
    () =>
      new URLSearchParams(location.search).get('view') === 'mindmap' ? (
        <MindMapDemo />
      ) : new URLSearchParams(location.search).get('view') === 'reasoning' ? (
        <ReasoningGraph graphKey="demo" snapshot={makeFixture().snapshots[5]} visible />
      ) : (
        <InvestigationView />
      ),
    root,
  );
