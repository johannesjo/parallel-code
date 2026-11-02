import { createMemo, createSignal, Show } from 'solid-js';
import { GraphCanvas } from '../graph/GraphCanvas';
import { visibleNodes } from '../graph/model';
import { createReducedMotion } from '../lib/reducedMotion';
import { boardToMap, type KanbanMapGrouping } from '../lib/kanban-map';
import type { KanbanBoard, KanbanCardRef } from '../lib/kanban';
import { SparkleIcon } from './icons';
import { urgentTask } from './KanbanCard';
import { stateLabel } from './board/task-state';
import { openBeside } from './board/TaskStatus';
// The map reuses the mind map editor's stage, hint and idea styling.
import '../mindmap/editor.css';

interface Props {
  board: KanbanBoard;
  /** Card indexes per column that the board's filters leave visible. */
  shown: readonly (readonly number[])[];
  projectId: string;
  /** The user's folds by node ID; branches without one use the map's default. */
  folds: Record<string, boolean>;
  onFoldsChange: (folds: Record<string, boolean>) => void;
  grouping: KanbanMapGrouping;
  onGroupingChange: (grouping: KanbanMapGrouping) => void;
  /** Asks the planning agent to give the cards themes. */
  onCluster: () => void;
  onOpenCard: (ref: KanbanCardRef) => void;
}

/**
 * KANBAN.md as a read-only mind map; changes happen on the board or through
 * the planning agent, which clusters the cards by writing `group:` lines.
 */
export function KanbanMapView(props: Props) {
  const reducedMotion = createReducedMotion();
  // Nothing starts selected: a selection dims the cards outside its branch.
  const [selected, setSelected] = createSignal('');
  const data = createMemo(() => boardToMap(props.board, props.shown, props.grouping));
  const collapsed = createMemo<ReadonlySet<string>>(() => {
    const { map, folded } = data();
    return new Set(
      map.records.filter((r) => props.folds[r.id] ?? folded.has(r.id)).map((r) => r.id),
    );
  });
  // A selection that a filter or fold hid would leave the map without a tab stop.
  const shownSelection = createMemo(() => {
    const id = selected();
    return visibleNodes(data().map.records, collapsed()).some((r) => r.id === id) ? id : '';
  });
  // A checklist item opens the card it belongs to.
  const cardRef = (id: string) => {
    const { map, cards } = data();
    return cards.get(id) ?? cards.get(map.records.find((r) => r.id === id)?.parent ?? '');
  };
  const open = (id: string) => {
    const ref = cardRef(id);
    if (ref) props.onOpenCard(ref);
  };
  const cardAt = (id: string) => {
    const ref = data().cards.get(id);
    return ref && props.board.columns[ref.column]?.cards[ref.card];
  };

  const renderBadge = (id: string) => {
    const linked = () => {
      const card = cardAt(id);
      return card && urgentTask(props.projectId, card);
    };
    return (
      <Show when={linked()}>
        {(current) => (
          <button
            type="button"
            class="graph-task-badge"
            data-state={current().state}
            title={`Open ${current().task.name}`}
            onPointerDown={(event) => event.stopPropagation()}
            onDblClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openBeside(current().task);
            }}
          >
            {stateLabel(current().task, current().state)} · {current().task.name}
          </button>
        )}
      </Show>
    );
  };

  return (
    <section class="mindmap-editor kanban-map" aria-label="Plan as a mind map">
      <div class="mindmap-toolbar" role="toolbar" aria-label="Map actions">
        <div class="kanban-view-toggle" role="group" aria-label="Group cards by">
          <button
            type="button"
            aria-pressed={props.grouping === 'column'}
            title="Group cards under their column"
            onClick={() => props.onGroupingChange('column')}
          >
            Columns
          </button>
          <button
            type="button"
            aria-pressed={props.grouping === 'theme'}
            title="Group cards under their group: line"
            onClick={() => props.onGroupingChange('theme')}
          >
            Themes
          </button>
        </div>
        <button
          type="button"
          class="mindmap-export"
          title="Ask the planning agent to sort the cards into themes"
          onClick={() => props.onCluster()}
        >
          <SparkleIcon /> Cluster with agent
        </button>
      </div>
      <div class="mindmap-stage">
        <GraphCanvas
          snapshot={data().map}
          selected={shownSelection()}
          locateId={shownSelection()}
          collapsed={collapsed()}
          faded={data().faded}
          follow={false}
          reducedMotion={reducedMotion()}
          pulseWork={false}
          locateRequest={0}
          locateOnlyIfOutside
          reserveCollapsedSpace={false}
          dimUnselected={false}
          dimUnconnected
          onSelect={setSelected}
          onClearSelection={() => setSelected('')}
          onHold={() => {}}
          onEdit={open}
          onNodeKeyDown={(id, event) => {
            if (event.key !== 'Enter' || event.isComposing) return;
            event.preventDefault();
            open(id);
          }}
          onToggle={(id) => props.onFoldsChange({ ...props.folds, [id]: !collapsed().has(id) })}
          renderNodeExtra={renderBadge}
        />
      </div>
      <p class="mindmap-hint">Double-click or Enter opens a card in the board · Ctrl+wheel zoom</p>
    </section>
  );
}
