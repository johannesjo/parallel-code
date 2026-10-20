import { createCanvasTaskControls } from './canvasTaskControls';
import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js';
import { createMindMap } from '../graph/model';
import { MindMapEditor, type ChangeDelivery } from '../mindmap/MindMapEditor';
import type { MapOrientation } from '../graph/layout';
import {
  hasManualChanges,
  manualChangesDigest,
  manualChangesPrompt,
} from '../investigation/manualChanges';
import {
  askCanvasBranch,
  referenceCanvasNode,
  replaceUnreadableMindMap,
  setTaskMindMap,
} from '../store/canvas';
import { canvasActivationInput } from '../store/canvas-activation';
import { activationBlocker } from '../investigation/live-activation';
import { canvasDefaultZoom } from '../lib/canvas-tabs';
import { sendPrompt, store } from '../store/store';
import type { Task } from '../store/types';

// Layout direction is view state, not document data: keep it for the session so
// remounting keeps it.
// shortcut: session-only memory of the orientation per task — persist it with the task if it
// should survive restarts.
const orientations = new Map<string, MapOrientation>();
// shortcut: session-only memory of the last change set sent per task — persist it with the
// task if the offer should stay hidden across restarts.
const sentChanges = new Map<string, string>();

export function TaskMindMap(props: { task: Task; visible: boolean; wide?: boolean }) {
  const taskControls = createCanvasTaskControls(() => ({
    taskId: props.task.id,
    canvas: 'mindmap',
  }));
  const initial = createMindMap();
  // The task ID is fixed for a mounted panel; read the cache once.
  const [orientation, setOrientation] = createSignal(
    untrack(() => orientations.get(props.task.id)) ?? 'horizontal',
  );
  const [sentDigest, setSentDigest] = createSignal(untrack(() => sentChanges.get(props.task.id)));
  createEffect(() => {
    // A saved map that could not be read stays on disk until the user or agent replaces it.
    if (props.visible && !props.task.mindMap && props.task.mindMapUnreadable === undefined)
      setTaskMindMap(props.task.id, initial);
  });
  // Offer delivery only while there is a change set the agent has not heard about yet.
  const sendChanges = createMemo((): ChangeDelivery | undefined => {
    const map = props.task.mindMap;
    const agentId = props.task.agentIds[0];
    if (!map || !hasManualChanges(map) || manualChangesDigest(map) === sentDigest()) return;
    const blocker =
      activationBlocker(canvasActivationInput(props.task, agentId), 'mindmap') || undefined;
    return {
      blocker,
      send: async () => {
        const prompt = manualChangesPrompt({
          taskId: props.task.id,
          canvas: 'mindmap',
          revision: map.revision,
          snapshot: map,
        });
        if (!prompt || !agentId) return;
        await sendPrompt(props.task.id, agentId, prompt, { appPrompt: true });
        const digest = manualChangesDigest(map);
        sentChanges.set(props.task.id, digest);
        setSentDigest(digest);
      },
    };
  });
  const unreadable = () => !props.task.mindMap && props.task.mindMapUnreadable !== undefined;
  return (
    <Show
      when={!unreadable()}
      fallback={
        <div class="mindmap-unreadable">
          <p>The saved mind map of this task could not be read. It is kept on disk untouched.</p>
          <button onClick={() => replaceUnreadableMindMap(props.task.id)}>
            Replace it with an empty map
          </button>
        </div>
      }
    >
      <MindMapEditor
        document={props.task.mindMap ?? initial}
        taskActions={taskControls.actions}
        renderTaskBadge={taskControls.renderBadge}
        visible={props.visible}
        defaultZoom={canvasDefaultZoom(props.wide)}
        showOwnership={store.canvasOwnershipBadges}
        sendChanges={sendChanges()}
        orientation={orientation()}
        onOrientationChange={(next) => {
          orientations.set(props.task.id, next);
          setOrientation(next);
        }}
        onBranchRequest={(request) => askCanvasBranch(props.task.id, 'mindmap', request)}
        onReference={(node) =>
          referenceCanvasNode(props.task.id, 'mindmap', node, props.task.mindMap?.revision ?? 0)
        }
        onChange={(document) => setTaskMindMap(props.task.id, document)}
      />
    </Show>
  );
}
