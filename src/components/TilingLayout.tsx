import {
  batch,
  Show,
  For,
  createMemo,
  createEffect,
  createSignal,
  onMount,
  onCleanup,
  ErrorBoundary,
  type JSX,
} from 'solid-js';
import {
  store,
  pickAndAddProject,
  closeTerminal,
  setTaskViewportVisibility,
  taskNeedsAttention,
  getPanelUserSize,
  setPanelUserSize,
  deletePanelUserSize,
  isPanelGroupCollapsed,
  togglePanelGroupCollapsed,
} from '../store/store';
import { closeTask } from '../store/tasks';
import type { PanelGroupType } from '../store/store';
import { TaskPanel } from './TaskPanel';
import { TerminalPanel } from './TerminalPanel';
import { NewTaskPlaceholder } from './NewTaskPlaceholder';
import { markDirty } from '../lib/terminalFitManager';
import { theme } from '../lib/theme';
import { mod } from '../lib/platform';
import { createCtrlShiftWheelResizeHandler } from '../lib/wheelZoom';

const VIEWPORT_EPSILON_PX = 4;

interface PanelGroup {
  projectId: string;
  groupType: PanelGroupType;
  panelIds: string[];
  color: string;
}

interface GroupInfo {
  projectId: string;
  groupType: PanelGroupType;
  isFirst: boolean;
  isLast: boolean;
  panelCount: number;
  color: string;
}

type TilingSegment = { type: 'group'; group: PanelGroup } | { type: 'panel'; panelId: string };

function computeTilingSegments(taskOrder: string[]): TilingSegment[] {
  const segments: TilingSegment[] = [];
  let current: PanelGroup | null = null;

  for (const panelId of taskOrder) {
    const task = store.tasks[panelId];
    if (!task) {
      if (current) {
        segments.push({ type: 'group', group: current });
        current = null;
      }
      segments.push({ type: 'panel', panelId });
      continue;
    }
    const project = store.projects.find((p) => p.id === task.projectId);
    if (!project) {
      if (current) {
        segments.push({ type: 'group', group: current });
        current = null;
      }
      segments.push({ type: 'panel', panelId });
      continue;
    }
    const groupType: PanelGroupType =
      task.coordinatorMode || task.coordinatedBy ? 'coordinator' : 'independent';
    if (current && current.projectId === task.projectId && current.groupType === groupType) {
      current.panelIds.push(panelId);
    } else {
      if (current) {
        segments.push({ type: 'group', group: current });
      }
      current = {
        projectId: task.projectId,
        groupType,
        panelIds: [panelId],
        color: project.color,
      };
    }
  }
  if (current) {
    segments.push({ type: 'group', group: current });
  }
  return segments;
}

function buildGroupInfoMap(segments: TilingSegment[]): Map<string, GroupInfo> {
  const map = new Map<string, GroupInfo>();
  for (const segment of segments) {
    if (segment.type === 'group') {
      const group = segment.group;
      const bg = `color-mix(in srgb, ${group.color} 50%, transparent)`;
      for (let i = 0; i < group.panelIds.length; i++) {
        map.set(group.panelIds[i], {
          projectId: group.projectId,
          groupType: group.groupType,
          isFirst: i === 0,
          isLast: i === group.panelIds.length - 1,
          panelCount: group.panelIds.length,
          color: bg,
        });
      }
    }
  }
  return map;
}

/** Tiling-layout top-level child. Distinct from `PanelChild` because this
 *  layout owns its own horizontal drag model — fixed placeholders, per-panel
 *  min/max widths, pixel-precise persisted sizes — that doesn't map onto the
 *  flex-first ResizablePanel semantics. */
interface TileChild {
  id: string;
  initialSize?: number;
  minSize?: number;
  maxSize?: number;
  fixed?: boolean;
  groupInfo?: GroupInfo;
  content: () => JSX.Element;
}

type GroupPanelEntry = { type: 'panel'; id: string; hidden: boolean; groupInfo: GroupInfo };

type RenderSegment =
  | { type: 'group'; key: string; start: number; end: number; color: string }
  | { type: 'single'; key: string; index: number };

type RenderSegmentInput = {
  id: string;
  groupInfo?: GroupInfo;
};

const renderSegmentCache = new Map<string, RenderSegment>();

function cachedRenderSegment(segment: RenderSegment): RenderSegment {
  const identity =
    segment.type === 'group'
      ? `${segment.type}:${segment.key}:${segment.start}:${segment.end}:${segment.color}`
      : `${segment.type}:${segment.key}:${segment.index}`;
  const cached = renderSegmentCache.get(identity);
  if (cached) return cached;
  renderSegmentCache.set(identity, segment);
  return segment;
}

function buildRenderSegments(items: RenderSegmentInput[]): RenderSegment[] {
  const segments: RenderSegment[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.groupInfo && !item.id.startsWith('__collapsed')) {
      const start = i;
      const color = item.groupInfo.color;
      const key = `group:${item.groupInfo.projectId}:${item.groupInfo.groupType}`;
      let end = i;
      while (end + 1 < items.length) {
        const next = items[end + 1];
        if (
          next.groupInfo?.projectId === item.groupInfo.projectId &&
          next.groupInfo?.groupType === item.groupInfo.groupType
        ) {
          end++;
        } else {
          break;
        }
      }
      segments.push(cachedRenderSegment({ type: 'group', key, start, end, color }));
      i = end + 1;
    } else {
      segments.push(cachedRenderSegment({ type: 'single', key: `single:${item.id}`, index: i }));
      i++;
    }
  }
  return segments;
}

export function buildRenderSegmentsForTest(items: RenderSegmentInput[]): RenderSegment[] {
  return buildRenderSegments(items);
}

function buildGroupPanelEntries(group: PanelGroup, collapsed: boolean): GroupPanelEntry[] {
  const groupInfoMap = buildGroupInfoMap([{ type: 'group', group }]);
  return group.panelIds.map((id, index) => ({
    type: 'panel',
    id,
    hidden: collapsed && index > 0,
    groupInfo: groupInfoMap.get(id)!,
  }));
}

export function buildGroupPanelEntriesForTest(
  group: PanelGroup & { collapsed: boolean },
): GroupPanelEntry[] {
  return buildGroupPanelEntries(group, group.collapsed);
}

export function isGroupPanelHiddenForTest(
  groupInfo: GroupInfo | undefined,
  isCollapsed: boolean,
): boolean {
  return isGroupPanelHidden(groupInfo, isCollapsed);
}

export function isPanelGroupCollapsibleForTest(panelCount: number): boolean {
  return isPanelGroupCollapsible(panelCount);
}

function isPanelGroupCollapsible(panelCount: number): boolean {
  return panelCount > 1;
}

function isGroupPanelHidden(groupInfo: GroupInfo | undefined, isCollapsed: boolean): boolean {
  return (
    !!groupInfo &&
    isPanelGroupCollapsible(groupInfo.panelCount) &&
    isCollapsed &&
    !groupInfo.isFirst
  );
}

export function groupWrapperPaddingForTest(isCollapsed: boolean): string {
  return groupWrapperPadding(isCollapsed);
}

function groupWrapperPadding(_isCollapsed: boolean): string {
  return '0 6px';
}

export function groupResizeHandleIndexForTest(
  groupStartIndex: number,
  groupEndIndex: number,
  isCollapsed: boolean,
): number {
  return groupResizeHandleIndex(groupStartIndex, groupEndIndex, isCollapsed);
}

function groupResizeHandleIndex(
  groupStartIndex: number,
  groupEndIndex: number,
  isCollapsed: boolean,
): number {
  return isCollapsed ? groupStartIndex : groupEndIndex;
}

export function groupPanelInnerHandleHiddenForTest(
  isCollapsed: boolean,
  isLastInGroup: boolean,
): boolean {
  return groupPanelInnerHandleHidden(isCollapsed, isLastInGroup);
}

function groupPanelInnerHandleHidden(isCollapsed: boolean, isLastInGroup: boolean): boolean {
  return isCollapsed || isLastInGroup;
}

export function isPanelGroupCollapseControlVisibleForTest(
  childHidden: boolean,
  focusMode: boolean,
  isLastInGroup: boolean | undefined,
  panelCount: number | undefined,
): boolean {
  return isPanelGroupCollapseControlVisible(childHidden, focusMode, isLastInGroup, panelCount);
}

function isPanelGroupCollapseControlVisible(
  childHidden: boolean,
  focusMode: boolean,
  isLastInGroup: boolean | undefined,
  panelCount: number | undefined,
): boolean {
  return (
    !childHidden &&
    !focusMode &&
    isLastInGroup === true &&
    panelCount !== undefined &&
    isPanelGroupCollapsible(panelCount)
  );
}

function hiddenPanelContentStyle(
  hidden: boolean,
  contentWidth: number | undefined,
): JSX.CSSProperties {
  return hidden
    ? {
        width: `${contentWidth ?? 0}px`,
        height: '100%',
        visibility: 'hidden',
        'pointer-events': 'none',
      }
    : {
        width: '100%',
        height: '100%',
      };
}

export function hiddenPanelContentStyleForTest(
  hidden: boolean,
  contentWidth: number | undefined,
): JSX.CSSProperties {
  return hiddenPanelContentStyle(hidden, contentWidth);
}

export function TilingLayout() {
  let containerRef: HTMLDivElement | undefined;
  const [hasOverflowLeft, setHasOverflowLeft] = createSignal(false);
  const [hasOverflowRight, setHasOverflowRight] = createSignal(false);
  const [dragging, setDragging] = createSignal<number | null>(null);
  // Transient per-drag width overrides. Written on mousemove, committed to
  // store.panelSizes on mouseup. Keeps autosave's snapshot stable mid-drag.
  const [dragPreview, setDragPreview] = createSignal<Record<string, number>>({});

  function sizeFor(child: TileChild): number {
    const preview = dragPreview()[child.id];
    if (preview !== undefined) return preview;
    const saved = getPanelUserSize(`tiling:${child.id}`);
    if (saved !== undefined) return saved;
    return child.initialSize ?? 200;
  }

  const syncTaskViewportVisibility = (
    entries: Record<string, 'visible' | 'offscreen-left' | 'offscreen-right'>,
  ) => {
    const current = store.taskViewportVisibility;
    const currentKeys = Object.keys(current);
    const nextKeys = Object.keys(entries);
    if (currentKeys.length === nextKeys.length) {
      let changed = false;
      for (const key of nextKeys) {
        if (current[key] !== entries[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
    }
    setTaskViewportVisibility(entries);
  };

  const updateViewportState = () => {
    if (!containerRef || store.focusMode) {
      setHasOverflowLeft(false);
      setHasOverflowRight(false);
      syncTaskViewportVisibility({});
      return;
    }

    const maxScrollLeft = containerRef.scrollWidth - containerRef.clientWidth;
    const isOverflowing = maxScrollLeft > 1;
    setHasOverflowLeft(isOverflowing && containerRef.scrollLeft > 1);
    setHasOverflowRight(isOverflowing && containerRef.scrollLeft < maxScrollLeft - 1);

    const containerRect = containerRef.getBoundingClientRect();
    const nextVisibility: Record<string, 'visible' | 'offscreen-left' | 'offscreen-right'> = {};
    const taskEls = containerRef.querySelectorAll<HTMLElement>('[data-task-id]');
    for (const el of taskEls) {
      const taskId = el.dataset.taskId;
      if (!taskId || !store.tasks[taskId]) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right <= containerRect.left + VIEWPORT_EPSILON_PX) {
        nextVisibility[taskId] = 'offscreen-left';
      } else if (rect.left >= containerRect.right - VIEWPORT_EPSILON_PX) {
        nextVisibility[taskId] = 'offscreen-right';
      } else {
        nextVisibility[taskId] = 'visible';
      }
    }
    syncTaskViewportVisibility(nextVisibility);
  };

  const offscreenAttention = createMemo(() => {
    let left = false;
    let right = false;
    for (const taskId of store.taskOrder) {
      if (!store.tasks[taskId]) continue;
      const visibility = store.taskViewportVisibility[taskId];
      if (!visibility || visibility === 'visible') continue;
      if (!taskNeedsAttention(taskId)) continue;
      if (visibility === 'offscreen-left') left = true;
      if (visibility === 'offscreen-right') right = true;
      if (left && right) break;
    }
    return { left, right };
  });

  onMount(() => {
    if (!containerRef) return;
    const handleWheel = createCtrlShiftWheelResizeHandler((deltaPx) => {
      if (store.focusMode) return;
      // Single batch so every consumer of `panelUserSize` (each panel wrapper)
      // re-runs once per wheel tick instead of once per modified key.
      batch(() => {
        for (const child of panelChildren()) {
          if (child.fixed) continue;
          const current = sizeFor(child);
          const min = child.minSize ?? 30;
          const max = child.maxSize ?? Infinity;
          setPanelUserSize(`tiling:${child.id}`, Math.min(max, Math.max(min, current + deltaPx)));
        }
      });
      requestAnimationFrame(() => updateViewportState());
    });
    let scrollRafPending = false;
    const handleScroll = () => {
      if (scrollRafPending) return;
      scrollRafPending = true;
      requestAnimationFrame(() => {
        scrollRafPending = false;
        updateViewportState();
      });
    };
    let resizeObserver: ResizeObserver | undefined;
    const observeStrip = () => {
      resizeObserver?.disconnect();
      if (!containerRef) return;
      resizeObserver = new ResizeObserver(() => updateViewportState());
      resizeObserver.observe(containerRef);
      const content = containerRef.firstElementChild;
      if (content instanceof HTMLElement) resizeObserver.observe(content);
      updateViewportState();
    };
    const mutationObserver = new MutationObserver(() => observeStrip());

    containerRef.addEventListener('wheel', handleWheel, { passive: false });
    containerRef.addEventListener('scroll', handleScroll, { passive: true });
    mutationObserver.observe(containerRef, { childList: true });
    observeStrip();

    onCleanup(() => {
      containerRef?.removeEventListener('wheel', handleWheel);
      containerRef?.removeEventListener('scroll', handleScroll);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      setTaskViewportVisibility({});
    });
  });

  // Recompute viewport state when panel order/structure changes.
  createEffect(() => {
    void store.taskOrder.join('|');
    requestAnimationFrame(() => updateViewportState());
  });

  // Scroll the active task panel into view when selection changes.
  // No-op in focus mode: panels are absolute-positioned, scrolling is meaningless.
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!containerRef) return;
    if (store.focusMode) return;
    if (!activeId) {
      updateViewportState();
      return;
    }

    const el = containerRef.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    requestAnimationFrame(() => updateViewportState());
  });

  // In focus mode: re-fit terminals of the newly active task so xterm picks up
  // the full-width container dimensions (visibility:hidden doesn't trigger
  // ResizeObserver).
  createEffect(() => {
    const activeId = store.activeTaskId;
    if (!store.focusMode || !activeId) return;
    const task = store.tasks[activeId];
    if (task) {
      for (const agentId of task.agentIds) markDirty(agentId);
      for (const shellId of task.shellAgentIds) markDirty(shellId);
    }
    const terminal = store.terminals[activeId];
    if (terminal) markDirty(terminal.agentId);
  });

  // Cache TileChild objects by ID so <For> sees stable references
  // and doesn't unmount/remount panels when taskOrder changes.
  const panelCache = new Map<string, TileChild>();

  function createPanelTileChild(panelId: string): TileChild {
    return {
      id: panelId,
      initialSize: 520,
      minSize: 300,
      content: () => {
        const task = store.tasks[panelId];
        const terminal = store.terminals[panelId];
        // eslint-disable-next-line solid/components-return-once
        if (!task && !terminal) return <div />;
        return (
          <div
            data-task-id={panelId}
            class={
              task?.closingStatus === 'removing' || terminal?.closingStatus === 'removing'
                ? 'task-removing'
                : 'task-appearing'
            }
            style={{
              height: '100%',
              padding: store.themePreset.startsWith('islands-')
                ? store.focusMode
                  ? '6px 0'
                  : '6px 1px'
                : '6px 3px',
              'box-sizing': 'border-box',
            }}
            onAnimationEnd={(e) => {
              if (e.animationName === 'taskAppear')
                e.currentTarget.classList.remove('task-appearing');
            }}
          >
            <ErrorBoundary
              fallback={(err, reset) => (
                <div
                  style={{
                    height: '100%',
                    display: 'flex',
                    'flex-direction': 'column',
                    'align-items': 'center',
                    'justify-content': 'center',
                    gap: '12px',
                    padding: '24px',
                    background: theme.islandBg,
                    'border-radius': '12px',
                    border: `1px solid ${theme.border}`,
                    color: theme.fgMuted,
                    'font-size': '14px',
                  }}
                >
                  <div style={{ color: theme.error, 'font-weight': '600' }}>Panel crashed</div>
                  <div
                    style={{
                      'text-align': 'center',
                      'word-break': 'break-word',
                      'max-width': '300px',
                    }}
                  >
                    {String(err)}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={reset}
                      style={{
                        background: theme.bgElevated,
                        border: `1px solid ${theme.border}`,
                        color: theme.fg,
                        padding: '6px 16px',
                        'border-radius': '6px',
                        cursor: 'pointer',
                      }}
                    >
                      Retry
                    </button>
                    <button
                      onClick={() => {
                        const task = store.tasks[panelId];
                        if (task) {
                          const msg =
                            task.gitIsolation !== 'worktree' || task.externalWorktree
                              ? 'Close this task? Running agents and shells will be stopped.'
                              : 'Close this task? The worktree and branch will be deleted.';
                          if (window.confirm(msg)) closeTask(panelId);
                        } else if (store.terminals[panelId]) {
                          closeTerminal(panelId);
                        }
                      }}
                      style={{
                        background: theme.bgElevated,
                        border: `1px solid ${theme.border}`,
                        color: theme.error,
                        padding: '6px 16px',
                        'border-radius': '6px',
                        cursor: 'pointer',
                      }}
                    >
                      {store.tasks[panelId] ? 'Close Task' : 'Close Terminal'}
                    </button>
                  </div>
                </div>
              )}
            >
              {task ? (
                <TaskPanel task={task} isActive={store.activeTaskId === panelId} />
              ) : terminal ? (
                <TerminalPanel terminal={terminal} isActive={store.activeTaskId === panelId} />
              ) : null}
            </ErrorBoundary>
          </div>
        );
      },
    };
  }

  const panelChildren = createMemo((): TileChild[] => {
    // Establish reactivity for projects and collapsed state
    void store.projects.length;
    void Object.keys(store.panelGroupCollapsed).join(',');

    const currentIds = new Set<string>(store.taskOrder);
    currentIds.add('__placeholder');

    // Remove stale entries for deleted tasks (keep collapsed placeholders)
    for (const key of panelCache.keys()) {
      if (key === '__placeholder') continue;
      if (key.startsWith('__collapsed:')) continue;
      if (!currentIds.has(key)) panelCache.delete(key);
    }

    const segments = computeTilingSegments(store.taskOrder);
    const panels: TileChild[] = [];

    for (const segment of segments) {
      if (segment.type === 'group') {
        const group = segment.group;
        const entries = buildGroupPanelEntries(
          group,
          isPanelGroupCollapsed(group.projectId, group.groupType),
        );
        for (const entry of entries) {
          const panelId = entry.id;
          let cached = panelCache.get(panelId);
          if (!cached) {
            cached = createPanelTileChild(panelId);
            panelCache.set(panelId, cached);
          }
          cached.groupInfo = entry.groupInfo;
          panels.push(cached);
        }
      } else {
        const panelId = segment.panelId;
        let cached = panelCache.get(panelId);
        if (!cached) {
          cached = createPanelTileChild(panelId);
          panelCache.set(panelId, cached);
        }
        cached.groupInfo = undefined;
        panels.push(cached);
      }
    }

    let placeholder = panelCache.get('__placeholder');
    if (!placeholder) {
      placeholder = {
        id: '__placeholder',
        initialSize: 54,
        fixed: true,
        content: () => <NewTaskPlaceholder />,
      };
      panelCache.set('__placeholder', placeholder);
    }
    panels.push(placeholder);

    return panels;
  });

  function handleDragStart(index: number, e: MouseEvent) {
    const panels = panelChildren();
    const child = panels[index];
    if (!child || child.fixed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startSize = sizeFor(child);
    const minSize = child.minSize ?? 30;
    const maxSize = child.maxSize ?? Infinity;
    const key = `tiling:${child.id}`;
    let latest = startSize;
    setDragging(index);

    function onMove(ev: MouseEvent) {
      latest = Math.min(maxSize, Math.max(minSize, startSize + (ev.clientX - startX)));
      setDragPreview({ [child.id]: latest });
    }
    function onUp() {
      setDragging(null);
      setDragPreview({});
      setPanelUserSize(key, latest);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const renderSegments = createMemo(() => buildRenderSegments(panelChildren()));

  function renderHandle(globalIdx: number, extraClass?: string): JSX.Element {
    const panels = panelChildren();
    const child = panels[globalIdx];
    const isGroupInnerHandle = () => {
      if (globalIdx >= panels.length - 1) return false;
      const next = panels[globalIdx + 1];
      return (
        child?.groupInfo != null &&
        next?.groupInfo != null &&
        child.groupInfo.projectId === next.groupInfo.projectId &&
        child.groupInfo.groupType === next.groupInfo.groupType
      );
    };
    return (
      <div
        class={`resize-handle resize-handle-h ${dragging() === globalIdx ? 'dragging' : ''} ${isGroupInnerHandle() ? 'group-inner-handle' : ''} ${extraClass ?? ''}`}
        onMouseDown={(e) => handleDragStart(globalIdx, e)}
        onDblClick={() => {
          if (dragging() !== null) return;
          const left = panels[globalIdx];
          const right = panels[globalIdx + 1];
          if (!left || !right) return;
          deletePanelUserSize([`tiling:${left.id}`, `tiling:${right.id}`]);
          requestAnimationFrame(() => updateViewportState());
        }}
      />
    );
  }

  function panelItemJSX(
    child: TileChild,
    globalIdx: number,
    total: number,
    options?: { hideHandle?: () => boolean },
  ): JSX.Element {
    const isPlaceholder = child.id === '__placeholder';
    const childHidden = () => {
      const groupInfo = child.groupInfo;
      return isGroupPanelHidden(
        groupInfo,
        groupInfo ? isPanelGroupCollapsed(groupInfo.projectId, groupInfo.groupType) : false,
      );
    };
    const childSize = () => sizeFor(child);

    const wrapperStyle = (): JSX.CSSProperties => {
      if (childHidden()) {
        return {
          width: '0',
          'min-width': '0',
          height: '100%',
          overflow: 'hidden',
          visibility: 'hidden',
          'pointer-events': 'none',
          'flex-shrink': '0',
          position: 'relative',
        };
      }
      if (store.focusMode) {
        if (isPlaceholder) return { display: 'none' };
        const isActive = child.id === store.activeTaskId;
        return {
          position: 'absolute',
          inset: store.themePreset.startsWith('islands-') ? '0 4px 0 0' : '0',
          width: '100%',
          height: '100%',
          visibility: isActive ? 'visible' : 'hidden',
          'pointer-events': isActive ? 'auto' : 'none',
          overflow: 'hidden',
        };
      }
      const s = childSize();
      const min = child.minSize ?? 0;
      return {
        width: `${s}px`,
        'min-width': `${min}px`,
        'flex-shrink': '0',
        overflow: 'hidden',
        position: 'relative',
      };
    };

    const showHandle = () =>
      !childHidden() &&
      !options?.hideHandle?.() &&
      !store.focusMode &&
      !child.fixed &&
      globalIdx < total - 1;
    const showCollapseBtn = () =>
      isPanelGroupCollapseControlVisible(
        childHidden(),
        store.focusMode,
        child.groupInfo?.isLast,
        child.groupInfo?.panelCount,
      );

    return (
      <>
        <div style={wrapperStyle()}>
          <div style={hiddenPanelContentStyle(childHidden(), childSize())}>{child.content()}</div>
        </div>
        <Show when={showCollapseBtn()}>
          <button
            class="panel-group-collapse-btn"
            title="Collapse group"
            onClick={() => {
              if (child.groupInfo) {
                togglePanelGroupCollapsed(child.groupInfo.projectId, child.groupInfo.groupType);
              }
            }}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M10.62 1.54a1 1 0 0 0-1.34.45l-3 6a1 1 0 0 0 0 .9l3 6a1 1 0 1 0 1.78-.9L8.28 8.44l2.78-5.55a1 1 0 0 0-.44-1.35z" />
            </svg>
          </button>
        </Show>
        <Show when={showHandle()}>{renderHandle(globalIdx)}</Show>
      </>
    );
  }

  return (
    <div class="tiling-layout-shell">
      <div ref={containerRef} class="tiling-layout-strip">
        <Show
          when={store.taskOrder.length > 0}
          fallback={
            <div
              class="empty-state"
              style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                width: '100%',
                height: '100%',
                'flex-direction': 'column',
                gap: '16px',
              }}
            >
              <Show
                when={store.collapsedTaskOrder.length === 0}
                fallback={
                  <div style={{ 'text-align': 'center' }}>
                    <div
                      style={{
                        'font-size': '16px',
                        color: theme.fgMuted,
                        'font-weight': '500',
                        'margin-bottom': '6px',
                      }}
                    >
                      All tasks are collapsed
                    </div>
                    <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
                      Click a task in the sidebar to restore it
                    </div>
                  </div>
                }
              >
                <Show
                  when={store.projects.length > 0}
                  fallback={
                    <>
                      <div
                        style={{
                          width: '56px',
                          height: '56px',
                          'border-radius': '16px',
                          background: theme.islandBg,
                          border: `1px solid ${theme.border}`,
                          display: 'flex',
                          'align-items': 'center',
                          'justify-content': 'center',
                          color: theme.fgSubtle,
                        }}
                      >
                        <svg
                          width="24"
                          height="24"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
                        </svg>
                      </div>
                      <div style={{ 'text-align': 'center' }}>
                        <div
                          style={{
                            'font-size': '16px',
                            color: theme.fgMuted,
                            'font-weight': '500',
                            'margin-bottom': '6px',
                          }}
                        >
                          Link your first project to get started
                        </div>
                        <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
                          A project is a local folder with your code
                        </div>
                      </div>
                      <button
                        onClick={() => pickAndAddProject()}
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '8px',
                          padding: '8px 20px',
                          color: theme.fg,
                          cursor: 'pointer',
                          'font-size': '14px',
                          'font-weight': '500',
                          display: 'flex',
                          'align-items': 'center',
                          gap: '6px',
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
                        </svg>
                        Link Project
                      </button>
                    </>
                  }
                >
                  <div
                    style={{
                      width: '56px',
                      height: '56px',
                      'border-radius': '16px',
                      background: theme.islandBg,
                      border: `1px solid ${theme.border}`,
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'center',
                      'font-size': '25px',
                      color: theme.fgSubtle,
                    }}
                  >
                    +
                  </div>
                  <div style={{ 'text-align': 'center' }}>
                    <div
                      style={{
                        'font-size': '16px',
                        color: theme.fgMuted,
                        'font-weight': '500',
                        'margin-bottom': '6px',
                      }}
                    >
                      No tasks yet
                    </div>
                    <div style={{ 'font-size': '13px', color: theme.fgSubtle }}>
                      Press{' '}
                      <kbd
                        style={{
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '4px',
                          padding: '2px 6px',
                          'font-family': "'JetBrains Mono', monospace",
                          'font-size': '12px',
                        }}
                      >
                        {mod}+N
                      </kbd>{' '}
                      to create a new task
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
          }
        >
          <div
            style={{
              display: 'flex',
              'flex-direction': 'row',
              height: '100%',
              position: 'relative',
              ...(store.focusMode
                ? { width: '100%', overflow: 'hidden' }
                : { width: 'fit-content', 'min-width': '100%' }),
            }}
          >
            <For each={renderSegments()}>
              {(currentSegment) => {
                const total = panelChildren().length;
                if (currentSegment.type === 'group') {
                  const groupPanelCount = currentSegment.end - currentSegment.start + 1;
                  const firstChild = panelChildren()[currentSegment.start];
                  const groupInfo = firstChild?.groupInfo;
                  const groupCollapsed = () =>
                    groupInfo && isPanelGroupCollapsible(groupInfo.panelCount)
                      ? isPanelGroupCollapsed(groupInfo.projectId, groupInfo.groupType)
                      : false;
                  return (
                    <>
                      <div
                        class="panel-group-wrapper"
                        style={{
                          display: 'flex',
                          'flex-direction': 'row',
                          background: currentSegment.color,
                          'border-radius': '12px',
                          overflow: 'hidden',
                          padding: groupWrapperPadding(groupCollapsed()),
                        }}
                      >
                        <For
                          each={panelChildren().slice(currentSegment.start, currentSegment.end + 1)}
                        >
                          {(child, localIdx) => {
                            const isLastInGroup = localIdx() === groupPanelCount - 1;
                            return panelItemJSX(child, currentSegment.start + localIdx(), total, {
                              hideHandle: () =>
                                groupPanelInnerHandleHidden(groupCollapsed(), isLastInGroup),
                            });
                          }}
                        </For>
                        <Show when={groupCollapsed() && groupInfo}>
                          {(info) => (
                            <button
                              class="panel-group-expand-btn"
                              title="Expand group"
                              onClick={() =>
                                togglePanelGroupCollapsed(info().projectId, info().groupType)
                              }
                            >
                              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                <path d="M5.38 1.54a1 1 0 0 1 1.34.45l3 6a1 1 0 0 1 0 .9l-3 6a1 1 0 1 1-1.78-.9l2.78-5.55-2.78-5.55a1 1 0 0 1 .44-1.35z" />
                              </svg>
                            </button>
                          )}
                        </Show>
                      </div>
                      <Show when={currentSegment.end < total - 1}>
                        {renderHandle(
                          groupResizeHandleIndex(
                            currentSegment.start,
                            currentSegment.end,
                            groupCollapsed(),
                          ),
                          'group-between-handle',
                        )}
                      </Show>
                    </>
                  );
                }
                return panelItemJSX(
                  panelChildren()[currentSegment.index],
                  currentSegment.index,
                  total,
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={hasOverflowLeft()}>
        <div
          class={`tiling-layout-scroll-affordance tiling-layout-scroll-affordance-left${offscreenAttention().left ? ' tiling-layout-scroll-affordance-attention' : ''}`}
          onClick={() => containerRef?.scrollTo({ left: 0, behavior: 'smooth' })}
          title={
            offscreenAttention().left
              ? 'Tasks need attention off-screen to the left — click to scroll'
              : 'Scroll to start'
          }
        />
      </Show>

      <Show when={hasOverflowRight()}>
        <div
          class={`tiling-layout-scroll-affordance tiling-layout-scroll-affordance-right${offscreenAttention().right ? ' tiling-layout-scroll-affordance-attention' : ''}`}
          onClick={() =>
            containerRef?.scrollTo({
              left: containerRef.scrollWidth - containerRef.clientWidth,
              behavior: 'smooth',
            })
          }
          title={
            offscreenAttention().right
              ? 'Tasks need attention off-screen to the right — click to scroll'
              : 'Scroll to end'
          }
        />
      </Show>
    </div>
  );
}
