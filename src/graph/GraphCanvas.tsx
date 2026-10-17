import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomTransform } from 'd3-zoom';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import { nodeTrail, visibleNodes, type MapData, type MapNode } from './model';
import { defaultAppearance, type NodeAppearance } from './presentation';
import { KindMark } from './KindMark';
import {
  CrosshairIcon,
  FrameCornersIcon,
  KebabIcon,
  LinkIcon,
  LockIcon,
  NotePageIcon,
} from '../components/icons';
import './graph.css';
import { adjacentNode, positionsFor, type Position, type MapOrientation } from './layout';
import { NodeContextMenu, type NodeAction } from './NodeContextMenu';
import { ownershipTitle } from './ownership';

export interface GraphProps<N extends MapNode = MapNode> {
  snapshot: MapData<N> & { activeId?: string; lastActiveId?: string };
  appearance?: (node: N, compact: boolean) => NodeAppearance;
  emphasis?: ReadonlyMap<string, string>;
  label?: string;
  showActivity?: boolean;
  dimUnselected?: boolean;
  /** Dim every note except the hovered or selected one and its parent, children and cross-links. */
  dimUnconnected?: boolean;
  editingId?: string;
  renderEditor?: (id: string) => JSX.Element;
  renderNodeExtra?: (id: string) => JSX.Element;
  /** Quick buttons shown under the selected note, before the menu button. */
  renderNodeActions?: (id: string) => JSX.Element;
  onEdit?: (id: string) => void;
  onNodeKeyDown?: (id: string, event: KeyboardEvent) => void;
  nodeActions?: (id: string) => NodeAction[];
  onToggle?: (id: string) => void;
  selected: string;
  locateId: string;
  collapsed: ReadonlySet<string>;
  follow: boolean;
  reducedMotion: boolean;
  pulseWork: boolean;
  visible?: boolean;
  defaultZoom?: number;
  locateRequest: number;
  locateOnlyIfOutside?: boolean;
  reserveCollapsedSpace?: boolean;
  /** Faint lock on items the user edited; the tooltip names the protected fields. */
  showOwnership?: boolean;
  /** Notes that recede with their branch until selected, such as rejected or unlikely ones. */
  faded?: ReadonlySet<string>;
  /** Change cues compare successive snapshots; a new key restarts without cues. */
  changeKey?: string;
  /** Controlled layout direction; omit to keep it per mount. */
  orientation?: MapOrientation;
  onOrientationChange?: (orientation: MapOrientation) => void;
  onSelect: (id: string) => void;
  onClearSelection?: () => void;
  onHold: () => void;
  onFindCurrent?: () => void;
}
interface Frame extends Position {
  opacity: number;
}

/** Solid owns every visible element. D3 supplies layout and camera gestures only. */
export function GraphCanvas<N extends MapNode>(props: GraphProps<N>) {
  let host!: HTMLDivElement;
  let surface!: SVGSVGElement;
  let animation = 0;
  let cameraAnimation = 0;
  let defaultZoomFrame = 0;
  let pendingDefaultZoom: number | undefined;
  let followingCamera = false;
  const [compact, setCompact] = createSignal(false);
  const [localOrientation, setLocalOrientation] = createSignal<MapOrientation>('horizontal');
  const orientation = () => props.orientation ?? localOrientation();
  const [ready, setReady] = createSignal(false);
  const [camera, setCamera] = createSignal(zoomIdentity);
  const [frame, setFrame] = createSignal(new Map<string, Frame>());
  const [hovered, setHovered] = createSignal<{ id: string; x: number; y: number }>();
  const [contextMenu, setContextMenu] = createSignal<{
    id: string;
    x: number;
    y: number;
    owner?: Element;
  }>();
  const [heights, setHeights] = createSignal(new Map<string, number>());
  const cardResize = new ResizeObserver((entries) => {
    setHeights((previous) => {
      const next = new Map(previous);
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.nodeId;
        const height = Math.ceil(entry.contentRect.height);
        if (id && height > 0) next.set(id, height);
      }
      return [...next].some(([id, height]) => previous.get(id) !== height) ? next : previous;
    });
  });
  onCleanup(() => cardResize.disconnect());
  const records = createMemo(() => new Map(props.snapshot.records.map((r) => [r.id, r])));
  const visible = createMemo(() => visibleNodes(props.snapshot.records, props.collapsed));
  // Key by stable IDs: assessments change without remounting buttons or losing focus.
  const ids = createMemo(() => visible().map((r) => r.id));
  const idSet = createMemo(() => new Set(ids()));
  createEffect(() => {
    const menu = contextMenu();
    if (menu && (props.visible === false || props.selected !== menu.id || !idSet().has(menu.id)))
      setContextMenu(undefined);
  });
  function openContextMenu(id: string, x: number, y: number, owner?: Element) {
    if (!props.nodeActions) return;
    hold();
    setHovered(undefined);
    props.onSelect(id);
    setContextMenu({ id, x, y, owner });
  }
  function closeContextMenu() {
    const id = contextMenu()?.id;
    setContextMenu(undefined);
    if (id && props.visible !== false)
      host
        .querySelector<HTMLElement>(`[data-record-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true });
  }
  const positions = createMemo(() =>
    positionsFor(
      props.reserveCollapsedSpace === false
        ? { ...props.snapshot, records: visible() }
        : props.snapshot,
      (node) => appearance(node),
      compact(),
      heights(),
      orientation(),
    ),
  );
  const emphasis = createMemo(() => {
    const result = new Map(props.emphasis);
    if (!props.pulseWork)
      for (const [id, value] of result) if (value === 'working') result.set(id, 'path');
    return result;
  });
  const workMarker = () => props.snapshot.activeId ?? props.snapshot.lastActiveId;
  const workLabel = (id: string) =>
    emphasis().get(id) === 'working' ? 'Working now' : 'Worked on last';
  const focusedPath = createMemo(() => {
    const active = props.snapshot.activeId;
    const starts = [props.selected, active && emphasis().get(active) === 'working' ? active : ''];
    return new Set(starts.flatMap((id) => nodeTrail(props.snapshot.records, id).map((r) => r.id)));
  });
  // Hover dims after a short pause and lets go after a short grace period, so moving between
  // notes hands the highlight over instead of releasing and re-dimming the whole graph.
  const [hoverFocus, setHoverFocus] = createSignal<string>();
  let hoverTimer = 0;
  createEffect(() => {
    const id = hovered()?.id;
    clearTimeout(hoverTimer);
    if (!props.dimUnconnected) setHoverFocus(undefined);
    else if (id && untrack(hoverFocus)) setHoverFocus(id);
    else hoverTimer = window.setTimeout(() => setHoverFocus(id), id ? 250 : 200);
  });
  onCleanup(() => clearTimeout(hoverTimer));
  const neighbourhood = createMemo(() => {
    const id = hoverFocus() || props.selected;
    if (!props.dimUnconnected || !id || !idSet().has(id)) return undefined;
    const near = new Set([id]);
    const parent = records().get(id)?.parent;
    if (parent) near.add(parent);
    for (const record of props.snapshot.records) if (record.parent === id) near.add(record.id);
    for (const link of props.snapshot.relations) {
      if (link.source === id) near.add(link.target);
      if (link.target === id) near.add(link.source);
    }
    return near;
  });
  const muted = (id: string) =>
    (props.dimUnselected !== false && focusedPath().size > 0 && !focusedPath().has(id)) ||
    (!!props.faded?.has(id) && props.selected !== id && emphasis().get(id) !== 'working') ||
    (!!neighbourhood() && !neighbourhood()?.has(id));
  const preview = () => {
    const record = records().get(hovered()?.id ?? '');
    return props.editingId || (props.onEdit && !record?.detail) ? undefined : record;
  };
  const point = (id: string) => frame().get(id) ?? { x: 0, y: 0, opacity: 0 };
  const recordFor = (id: string) => {
    const record = records().get(id);
    if (!record) throw new Error(`Missing record ${id}`);
    return record;
  };
  function appearance(node: N) {
    return props.appearance?.(node, compact()) ?? defaultAppearance(node, compact());
  }
  const heightFor = (id: string) => heights().get(id) ?? appearance(recordFor(id)).height;
  const targetFor = (id: string) => {
    const target = positions().get(id);
    if (!target) throw new Error(`Missing position ${id}`);
    return target;
  };
  const onPath = (id: string) => ['path', 'working'].includes(emphasis().get(id) ?? '');
  const links = createMemo(() => {
    const shown = props.snapshot.relations.filter(
      (r) => idSet().has(r.source) && idSet().has(r.target),
    );
    // A selected note shows only its own cross-links; the rest would just add clutter.
    const selected = idSet().has(props.selected) ? props.selected : '';
    return selected ? shown.filter((r) => r.source === selected || r.target === selected) : shown;
  });
  const linkActive = (link: { source: string; target: string }) =>
    [props.selected, hovered()?.id].some((id) => id && (link.source === id || link.target === id));
  const cues = createChangeCues(
    () => props.snapshot.records,
    () => props.changeKey,
    () => idSet(),
  );

  const newBelow = (id: string) => (props.collapsed.has(id) ? cues.hiddenBelow(id) : 0);
  const renderCollapseControl = (id: string) => (
    <div class="mindmap-collapse-control">
      <button
        class="mindmap-collapse"
        tabIndex={-1}
        aria-label={`${props.collapsed.has(id) ? 'Expand' : 'Collapse'} ${recordFor(id).title}${newBelow(id) ? ` (${newBelow(id)} new)` : ''}`}
        aria-expanded={!props.collapsed.has(id)}
        onClick={() => {
          setHovered(undefined);
          props.onToggle?.(id);
        }}
      >
        {props.collapsed.has(id) ? '+' : '−'}
      </button>
      <Show when={newBelow(id)}>
        <span class="mindmap-new-badge" aria-hidden="true">
          {newBelow(id)} new
        </span>
      </Show>
    </div>
  );

  const navigation = zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.08, 1.8])
    .extent((): [[number, number], [number, number]] => [
      [0, 0],
      [host.clientWidth, host.clientHeight],
    ])
    .wheelDelta((event: WheelEvent) => -event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.004))
    .clickDistance(5)
    .filter((event: MouseEvent | WheelEvent) =>
      event.type === 'wheel'
        ? event.ctrlKey || event.metaKey
        : !event.button &&
          !(event.target instanceof Element && event.target.closest('button, input, textarea')),
    )
    .on('start', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      if (event.sourceEvent) hold();
    })
    .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
      setCamera(event.transform);
      setHovered(undefined);
    });

  function hold() {
    cancelAnimationFrame(cameraAnimation);
    props.onHold();
  }
  function moveCamera(target: ZoomTransform, animate = false) {
    cancelAnimationFrame(cameraAnimation);
    followingCamera = false;
    const start = untrack(camera);
    const begin = performance.now();
    const duration = animate && !props.reducedMotion ? 300 : 0;
    const tick = (now: number) => {
      const t = duration ? Math.min(1, (now - begin) / duration) : 1;
      const ease = 1 - (1 - t) ** 3;
      select(surface).call(
        navigation.transform,
        zoomIdentity
          .translate(start.x + (target.x - start.x) * ease, start.y + (target.y - start.y) * ease)
          .scale(start.k + (target.k - start.k) * ease),
      );
      if (t < 1) cameraAnimation = requestAnimationFrame(tick);
    };
    tick(begin);
  }
  function initialCamera(scale: number) {
    // Horizontal maps grow to the right: anchor the root at the left edge, centred vertically.
    if (orientation() === 'horizontal') {
      const root = props.snapshot.records.find((record) => !record.parent);
      const width = root ? appearance(root).width : 0;
      return zoomIdentity.translate(24 + (width / 2) * scale, host.clientHeight / 2).scale(scale);
    }
    return zoomIdentity.translate(host.clientWidth / 2, 72).scale(scale);
  }
  function locate(id: string, scale = camera().k, animate = true) {
    const p = positions().get(id);
    if (p)
      moveCamera(
        zoomIdentity
          .translate(host.clientWidth / 2 - p.x * scale, host.clientHeight / 2 - p.y * scale)
          .scale(scale),
        animate,
      );
  }
  function locateIfOutside(id: string) {
    const target = positions().get(id);
    const record = records().get(id);
    if (!target || !record) return;
    const [x, y] = camera().apply([target.x, target.y]);
    const width = (appearance(record).width * camera().k) / 2 + 20;
    const height = (heightFor(id) * camera().k) / 2 + 30;
    if (
      x < width ||
      x > host.clientWidth - width ||
      y < height ||
      y > host.clientHeight - height - 48
    )
      locate(id, camera().k);
  }
  function navigateNode(id: string, event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !event.key.startsWith('Arrow')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const visiblePositions = new Map(ids().map((id) => [id, frame().get(id) ?? targetFor(id)]));
    const target = adjacentNode(visiblePositions, id, event.key);
    if (!target) return;
    hold();
    props.onSelect(target);
    host
      .querySelector<HTMLElement>(`[data-record-id="${CSS.escape(target)}"]`)
      ?.focus({ preventScroll: true });
    locateIfOutside(target);
  }
  function fit() {
    const boxes = visible().map((r) => ({
      ...targetFor(r.id),
      ...appearance(r),
      height: heightFor(r.id),
    }));
    if (!boxes.length) return;
    const left = Math.min(...boxes.map((p) => p.x - p.width / 2));
    const right = Math.max(...boxes.map((p) => p.x + p.width / 2));
    const top = Math.min(...boxes.map((p) => p.y - p.height / 2)) - 24;
    const bottom = Math.max(...boxes.map((p) => p.y + p.height / 2));
    const k = Math.max(
      0.08,
      Math.min(
        1,
        (host.clientWidth - 80) / (right - left),
        (host.clientHeight - 80) / (bottom - top),
      ),
    );
    moveCamera(
      zoomIdentity
        .translate(
          host.clientWidth / 2 - ((left + right) / 2) * k,
          host.clientHeight / 2 - ((top + bottom) / 2) * k,
        )
        .scale(k),
      true,
    );
  }
  function scaleBy(factor: number) {
    hold();
    select(surface).call(navigation.scaleBy, factor);
  }
  function zoomKey(event: KeyboardEvent) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') scaleBy(1.2);
    if (event.key === '-') scaleBy(1 / 1.2);
  }
  function wheel(event: WheelEvent) {
    if (event.ctrlKey || event.metaKey) return; // D3 handles pinch / modified wheel at the pointer.
    event.preventDefault();
    hold();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
    const x = (event.shiftKey ? event.deltaY : event.deltaX) * units;
    const y = (event.shiftKey ? 0 : event.deltaY) * units;
    select(surface).call(navigation.translateBy, -x / camera().k, -y / camera().k);
  }
  function showPreview(id: string, element: HTMLElement) {
    const box = element.getBoundingClientRect();
    const bounds = host.getBoundingClientRect();
    setHovered({
      id,
      x: Math.max(8, Math.min(box.right - bounds.left + 12, host.clientWidth - 288)),
      y: Math.max(8, Math.min(box.top - bounds.top, host.clientHeight - 220)),
    });
  }
  function edge(source: string, target: string) {
    const a = point(source),
      b = point(target);
    if (orientation() === 'horizontal') {
      const x1 = a.x + appearance(recordFor(source)).width / 2;
      const x2 = b.x - appearance(recordFor(target)).width / 2;
      const mid = (x1 + x2) / 2;
      return `M${x1},${a.y} C${mid},${a.y} ${mid},${b.y} ${x2},${b.y}`;
    }
    const y1 = a.y + heightFor(source) / 2;
    const y2 = b.y - heightFor(target) / 2;
    const mid = (y1 + y2) / 2;
    return `M${a.x},${y1} C${a.x},${mid} ${b.x},${mid} ${b.x},${y2}`;
  }

  // Peer relations travel outside the whole row, including taller intervening cards.
  // Use the layout positions to identify rows, but follow animated card positions.
  const peerLinks = createMemo(() => {
    const axis = orientation() === 'horizontal' ? 'x' : 'y';
    return links().filter(
      (link) =>
        link.source !== link.target &&
        targetFor(link.source)[axis] === targetFor(link.target)[axis],
    );
  });
  function relationRoute(link: (typeof props.snapshot.relations)[number]) {
    const a = point(link.source),
      b = point(link.target);
    const index = peerLinks().indexOf(link);
    if (index < 0)
      return { path: edge(link.source, link.target), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6 };
    const horizontal = orientation() === 'horizontal';
    const axis = horizontal ? 'x' : 'y';
    const breadth = horizontal ? 'y' : 'x';
    const halfDepth = (id: string) =>
      horizontal ? appearance(recordFor(id)).width / 2 : heightFor(id) / 2;
    const rowEnd = Math.max(
      ...ids()
        .filter((id) => targetFor(id)[axis] === targetFor(link.source)[axis])
        .map((id) => point(id)[axis] + halfDepth(id)),
    );
    const lane = rowEnd + 54 + (24 * index) / Math.max(1, peerLinks().length - 1);
    // Offset ports from the center to clear the expand/collapse buttons.
    const start =
      a[breadth] +
      (horizontal ? heightFor(link.source) : appearance(recordFor(link.source)).width) / 4;
    const end =
      b[breadth] +
      (horizontal ? heightFor(link.target) : appearance(recordFor(link.target)).width) / 4;
    const direction = Math.sign(end - start);
    const xy = (across: number, depth: number) =>
      horizontal ? `${depth},${across}` : `${across},${depth}`;
    const path = `M${xy(start, a[axis] + halfDepth(link.source))} L${xy(start, lane - 8)} Q${xy(start, lane)} ${xy(start + direction * 8, lane)} L${xy(end - direction * 8, lane)} Q${xy(end, lane)} ${xy(end, lane - 8)} L${xy(end, b[axis] + halfDepth(link.target))}`;
    return {
      path,
      x: horizontal ? lane + 8 : (start + end) / 2,
      y: horizontal ? (start + end) / 2 : lane - 6,
    };
  }

  function applyDefaultZoom() {
    if (
      pendingDefaultZoom === undefined ||
      !ready() ||
      host.clientWidth <= 0 ||
      host.clientHeight <= 0
    )
      return;
    const next = pendingDefaultZoom;
    pendingDefaultZoom = undefined;
    setCompact(host.clientWidth < 600);
    locate(props.selected || ids()[0], next);
  }

  onMount(() => {
    select(surface).call(navigation).on('dblclick.zoom', null);
    surface.addEventListener('wheel', wheel, { passive: false });
    const initialize = () => {
      if (host.clientWidth > 0) setCompact(host.clientWidth < 600);
      if (!ready() && host.clientWidth > 0 && host.clientHeight > 0) {
        moveCamera(initialCamera(props.defaultZoom ?? 1));
        setReady(true);
      }
      applyDefaultZoom();
    };
    initialize();
    const resize = new ResizeObserver(() => {
      setHovered(undefined);
      initialize();
    });
    resize.observe(host);
    onCleanup(() => {
      resize.disconnect();
      surface.removeEventListener('wheel', wheel);
      select(surface).on('.zoom', null);
    });
  });
  let previousDefaultZoom = untrack(() => props.defaultZoom ?? 1);
  createEffect(() => {
    const next = props.defaultZoom ?? 1;
    if (next === previousDefaultZoom) return;
    previousDefaultZoom = next;
    pendingDefaultZoom = next;
    cancelAnimationFrame(defaultZoomFrame);
    // Layout flips move this same element; measure after it has been reattached.
    defaultZoomFrame = requestAnimationFrame(applyDefaultZoom);
  });
  let wasVisible = untrack(() => props.visible !== false);
  createEffect(() => {
    const targets = positions();
    const shown = ids();
    const reduced = props.reducedMotion || props.visible === false || !wasVisible;
    wasVisible = props.visible !== false;
    const byId = records();
    cancelAnimationFrame(animation);
    const previous = untrack(frame);
    const starts = new Map(
      shown.map((id) => {
        const target = targets.get(id) ?? { x: 0, y: 0 };
        const parent = previous.get(byId.get(id)?.parent ?? '');
        return [
          id,
          previous.get(id) ?? {
            x: parent?.x ?? target.x,
            y: parent ? parent.y + 32 : target.y - 16,
            opacity: 0,
          },
        ] as const;
      }),
    );
    const begin = performance.now();
    const tick = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - begin) / 320);
      const ease = 1 - (1 - t) ** 3;
      setFrame(
        new Map(
          shown.map((id) => {
            const b = targets.get(id) ?? { x: 0, y: 0 };
            const a = starts.get(id) ?? { ...b, opacity: 0 };
            return [
              id,
              {
                x: a.x + (b.x - a.x) * ease,
                y: a.y + (b.y - a.y) * ease,
                opacity: a.opacity + (1 - a.opacity) * ease,
              },
            ];
          }),
        ),
      );
      if (t < 1) animation = requestAnimationFrame(tick);
    };
    tick(begin);
  });
  let locateSeen = 0;
  createEffect(() => {
    if (!ready()) return;
    if (props.visible === false) return;
    const locateRequest = props.locateRequest;
    untrack(() => {
      if (locateRequest !== locateSeen) {
        locateSeen = locateRequest;
        if (props.locateOnlyIfOutside) locateIfOutside(props.locateId);
        else locate(props.locateId, 1);
      }
    });
  });
  let cameraWasVisible = untrack(() => props.visible !== false);
  createEffect(() => {
    const active = props.snapshot.activeId;
    const target = active ? positions().get(active) : undefined;
    if (!ready()) return;
    const animate = cameraWasVisible;
    cameraWasVisible = props.visible !== false;
    if (props.visible === false) {
      cancelAnimationFrame(cameraAnimation);
      return;
    }
    if (!props.follow) {
      if (followingCamera) cancelAnimationFrame(cameraAnimation);
      return;
    }
    untrack(() => {
      if (!target || !active || !idSet().has(active)) return;
      const [x, y] = camera().apply([target.x, target.y]);
      const margin = compact() ? appearance(recordFor(active)).width / 2 + 16 : 140;
      if (x < margin || x > host.clientWidth - margin || y < 64 || y > host.clientHeight - 96) {
        locate(active, camera().k, animate);
        followingCamera = true;
      }
    });
  });
  // A layout flip from another editor of the same map would otherwise leave the camera aimed
  // at where the notes used to be.
  createEffect(
    on(
      () => props.orientation,
      () => {
        if (ready()) fit();
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    cancelAnimationFrame(animation);
    cancelAnimationFrame(cameraAnimation);
    cancelAnimationFrame(defaultZoomFrame);
  });

  return (
    <div
      ref={host}
      class="investigation-graph-wrap"
      data-compact={compact()}
      data-hover-dim={!!hoverFocus()}
      data-reduced={props.reducedMotion}
      data-orientation={orientation()}
    >
      <svg
        ref={surface}
        class="investigation-graph investigation-svg"
        width="100%"
        height="100%"
        aria-label={props.label ?? 'Mind map. Arrow keys pan; plus and minus zoom.'}
        tabIndex={0}
        onClick={(event) => {
          if (
            !props.onClearSelection ||
            event.defaultPrevented ||
            !(event.target instanceof Element) ||
            event.target.closest('foreignObject')
          )
            return;
          hold();
          setHovered(undefined);
          setContextMenu(undefined);
          props.onClearSelection();
          surface.focus({ preventScroll: true });
        }}
        onKeyDown={(event) => {
          if (
            event.target !== surface ||
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          const offsets: Record<string, [number, number]> = {
            ArrowUp: [0, 60],
            ArrowDown: [0, -60],
            ArrowLeft: [60, 0],
            ArrowRight: [-60, 0],
          };
          const delta = offsets[event.key];
          if (delta) {
            event.preventDefault();
            hold();
            select(surface).call(
              navigation.translateBy,
              delta[0] / camera().k,
              delta[1] / camera().k,
            );
          }
          if (event.key === '+' || event.key === '=') scaleBy(1.2);
          if (event.key === '-') scaleBy(1 / 1.2);
          // Mark it handled so the same press doesn't also leave focus mode.
          if (event.key === 'Escape' && hovered()) {
            event.preventDefault();
            setHovered(undefined);
          }
        }}
      >
        <g transform={camera().toString()}>
          <For each={ids()}>
            {(id) => {
              const parent = () => records().get(id)?.parent;
              return (
                <Show when={parent()}>
                  {(parentId) => (
                    <Show when={idSet().has(parentId())}>
                      <path
                        class="investigation-tree-edge"
                        data-path={onPath(id)}
                        d={edge(parentId(), id)}
                        opacity={
                          Math.min(point(id).opacity, point(parentId()).opacity) *
                          (muted(id) ? 0.15 : 1)
                        }
                      />
                    </Show>
                  )}
                </Show>
              );
            }}
          </For>
          <For each={links()}>
            {(link) => {
              const route = createMemo(() => relationRoute(link));
              return (
                <g
                  class="investigation-evidence-link"
                  data-kind={link.kind}
                  data-active={linkActive(link)}
                  opacity={Math.min(point(link.source).opacity, point(link.target).opacity)}
                >
                  <path d={route().path} />
                  <text
                    x={route().x}
                    y={route().y}
                    style={{
                      'text-anchor':
                        peerLinks().includes(link) && orientation() === 'horizontal'
                          ? 'start'
                          : 'middle',
                    }}
                  >
                    {link.kind}
                  </text>
                </g>
              );
            }}
          </For>
          <For each={ids()}>
            {(id) => {
              const record = () => recordFor(id);
              const type = () => appearance(record());
              return (
                <foreignObject
                  x={point(id).x - type().width / 2 - 8}
                  y={point(id).y - heightFor(id) / 2 - 26}
                  width={type().width + 16}
                  height={heightFor(id) + 40}
                  style={{ overflow: 'visible', opacity: point(id).opacity }}
                >
                  <div
                    ref={(element) => {
                      cardResize.observe(element);
                      onCleanup(() => cardResize.unobserve(element));
                    }}
                    data-node-id={id}
                    class="investigation-node-shell"
                    onContextMenu={(event) => {
                      if (!props.nodeActions) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      openContextMenu(
                        id,
                        event.clientX || bounds.left,
                        event.clientY || bounds.bottom,
                      );
                    }}
                    style={{
                      '--note-color': `var(${type().color})`,
                      width: `${type().width}px`,
                      'min-height': `${type().height}px`,
                    }}
                    data-kind={type().kind}
                    data-emphasis={emphasis().get(id)}
                    data-selected={props.selected === id}
                    data-muted={muted(id)}
                    data-fresh={cues.fresh().has(id)}
                  >
                    <Show when={workMarker() === id}>
                      <span
                        class="investigation-working-label"
                        data-working={emphasis().get(id) === 'working'}
                      >
                        <i /> {workLabel(id)}
                      </span>
                    </Show>
                    <Show
                      when={props.editingId === id}
                      fallback={
                        <button
                          class="investigation-node"
                          onDblClick={() => props.onEdit?.(id)}
                          data-record-id={id}
                          aria-label={`${type().label ? `${type().label}: ` : ''}${record().title}. ${type().status ?? ''}${workMarker() === id ? ` ${workLabel(id)}.` : ''}${type().kind === 'hypothesis' && type().confidence !== undefined ? ` Agent-reported confidence: ${Math.round((type().confidence ?? 0) * 100)}%.` : ''}${record().detail.trim() ? ' Has notes.' : ''}${props.showOwnership && record().userEdited?.length ? ' Edited by you.' : ''}`}
                          aria-current={props.selected === id ? 'true' : undefined}
                          aria-haspopup={props.nodeActions ? 'menu' : undefined}
                          aria-expanded={props.nodeActions ? contextMenu()?.id === id : undefined}
                          tabIndex={props.onEdit && (props.selected || ids()[0]) !== id ? -1 : 0}
                          onClick={() => {
                            setHovered(undefined);
                            props.onSelect(id);
                          }}
                          onPointerEnter={(e) => showPreview(id, e.currentTarget)}
                          onPointerLeave={() => setHovered(undefined)}
                          onFocus={(e) => {
                            if (props.onEdit) props.onSelect(id);
                            showPreview(id, e.currentTarget);
                          }}
                          onBlur={() => setHovered(undefined)}
                          onKeyDown={(e) => {
                            if (
                              props.nodeActions &&
                              (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))
                            ) {
                              e.preventDefault();
                              e.stopPropagation();
                              const bounds = e.currentTarget.getBoundingClientRect();
                              openContextMenu(id, bounds.left, bounds.bottom);
                              return;
                            }
                            props.onNodeKeyDown?.(id, e);
                            navigateNode(id, e);
                            zoomKey(e);
                            if (e.key === 'Escape') setHovered(undefined);
                          }}
                        >
                          <span class="investigation-node-symbol" aria-hidden="true">
                            <KindMark kind={type().kind} mark={type().mark} />
                          </span>
                          <span class="investigation-node-copy">
                            <span class="investigation-node-kind">{type().label}</span>
                            <strong>{record().title}</strong>
                            <Show
                              when={type().kind === 'hypothesis' && type().confidence !== undefined}
                            >
                              <span
                                class="investigation-node-confidence"
                                title="Agent-reported confidence"
                              >
                                {Math.round((type().confidence ?? 0) * 100)}% confidence
                              </span>
                            </Show>
                          </span>
                          <span class="mindmap-node-marks">
                            <Show when={props.showOwnership && ownershipTitle(record().userEdited)}>
                              {(title) => (
                                <span class="mindmap-ownership" title={title()}>
                                  <LockIcon size={10} />
                                </span>
                              )}
                            </Show>
                            <Show when={record().sources?.length}>
                              {(count) => (
                                <span
                                  class="mindmap-sources-indicator"
                                  title={`${count()} ${count() === 1 ? 'source' : 'sources'}: ${(record().sources ?? []).map((s) => s.label).join(', ')}`}
                                  aria-hidden="true"
                                >
                                  <LinkIcon size={10} />
                                </span>
                              )}
                            </Show>
                            <Show when={record().detail.trim()}>
                              <span
                                class="mindmap-notes-indicator"
                                title="Has notes"
                                aria-hidden="true"
                              >
                                <NotePageIcon size={14} />
                              </span>
                            </Show>
                          </span>
                          <Show when={props.collapsed.has(id)}>
                            <span class="investigation-collapsed-mark">+</span>
                          </Show>
                        </button>
                      }
                    >
                      {props.renderEditor?.(id)}
                    </Show>
                    {props.renderNodeExtra?.(id)}
                    <Show
                      when={props.nodeActions && props.selected === id && props.editingId !== id}
                    >
                      <span
                        class="mindmap-node-actions"
                        role="toolbar"
                        aria-label="Selected node actions"
                        // A quick action may move the selection and unmount this bar mid-click;
                        // the canvas must not then read the orphaned target as an empty click.
                        onClick={(event) => event.stopPropagation()}
                      >
                        {props.renderNodeActions?.(id)}
                        <button
                          tabIndex={-1}
                          title="More actions"
                          aria-label="More actions"
                          aria-haspopup="menu"
                          aria-expanded={contextMenu()?.id === id}
                          onClick={(event) => {
                            if (contextMenu()?.id === id) return closeContextMenu();
                            const bounds = event.currentTarget.getBoundingClientRect();
                            openContextMenu(
                              id,
                              bounds.left,
                              bounds.bottom + 4,
                              event.currentTarget,
                            );
                          }}
                        >
                          <KebabIcon size={12} />
                        </button>
                      </span>
                    </Show>
                    <Show
                      when={['disputed', 'reopened', 'rejected', 'complete'].includes(
                        type().status ?? '',
                      )}
                    >
                      <span class="investigation-node-assessment" data-status={type().status ?? ''}>
                        {(type().status ?? '') === 'complete'
                          ? '✓ Complete'
                          : (type().status ?? '')}
                      </span>
                    </Show>
                  </div>
                </foreignObject>
              );
            }}
          </For>
          {/* Paint branch controls last so padded node bounds cannot intercept clicks. */}
          <Show when={props.onToggle}>
            <For
              each={ids().filter((id) => props.snapshot.records.some((node) => node.parent === id))}
            >
              {(id) => (
                <foreignObject
                  x={
                    orientation() === 'horizontal'
                      ? point(id).x + appearance(recordFor(id)).width / 2 + 14
                      : point(id).x - 14
                  }
                  y={
                    orientation() === 'horizontal'
                      ? point(id).y - 14
                      : point(id).y + heightFor(id) / 2 + 14
                  }
                  width={28}
                  height={28}
                  style={{ opacity: point(id).opacity, overflow: 'visible' }}
                >
                  {renderCollapseControl(id)}
                </foreignObject>
              )}
            </For>
          </Show>
        </g>
      </svg>
      <div class="investigation-navigation" aria-label="Map navigation">
        <button
          aria-label={`Switch to ${orientation() === 'vertical' ? 'horizontal' : 'vertical'} layout`}
          title={orientation() === 'vertical' ? 'Top to bottom' : 'Left to right'}
          onClick={() => {
            hold();
            setHovered(undefined);
            const next = orientation() === 'vertical' ? 'horizontal' : 'vertical';
            setLocalOrientation(next);
            props.onOrientationChange?.(next);
            fit();
          }}
        >
          <span aria-hidden="true">{orientation() === 'vertical' ? '↕' : '↔'}</span>
          <span class="investigation-navigation-label">
            {orientation() === 'vertical' ? ' Vertical' : ' Horizontal'}
          </span>
        </button>
        <button aria-label="Zoom out" title="Zoom out" onClick={() => scaleBy(1 / 1.2)}>
          −
        </button>
        <button
          aria-label="Reset zoom to 100 percent"
          title="Reset zoom to 100 percent"
          onClick={() => {
            hold();
            select(surface).call(navigation.scaleTo, 1);
          }}
        >
          {Math.round(camera().k * 100)}%
        </button>
        <button aria-label="Zoom in" title="Zoom in" onClick={() => scaleBy(1.2)}>
          +
        </button>
        <button
          aria-label="Fit map"
          title="Fit map"
          onClick={() => {
            hold();
            fit();
          }}
        >
          <FrameCornersIcon size={14} class="investigation-navigation-icon" />
          <span class="investigation-navigation-label">Fit map</span>
        </button>
        <Show when={props.showActivity || props.onFindCurrent || props.snapshot.activeId}>
          <button
            disabled={!props.snapshot.activeId}
            aria-label="Find current"
            title={props.snapshot.activeId ? 'Find current work' : 'No current work reported'}
            onClick={() => {
              hold();
              props.onFindCurrent?.();
              if (!props.onFindCurrent && props.snapshot.activeId)
                locate(props.snapshot.activeId, 1);
            }}
          >
            <CrosshairIcon size={14} class="investigation-navigation-icon" />
            <span class="investigation-navigation-label">Find current</span>
          </button>
        </Show>
      </div>
      <Show when={contextMenu()} keyed>
        {(menu) => (
          <NodeContextMenu
            anchor={menu}
            actions={props.nodeActions?.(menu.id) ?? []}
            owner={menu.owner}
            onClose={closeContextMenu}
          />
        )}
      </Show>
      <Show when={!contextMenu() && preview()}>
        {(r) => (
          <div
            class="investigation-preview"
            role="tooltip"
            style={{ left: `${hovered()?.x ?? 0}px`, top: `${hovered()?.y ?? 0}px` }}
          >
            <div class="investigation-note-type">
              {appearance(r()).label}
              <span>{appearance(r()).status}</span>
            </div>
            <strong>{r().title}</strong>
            <p>{r().detail}</p>
            <small>
              {nodeTrail(props.snapshot.records, r().id)
                .slice(0, -1)
                .map((item) => item.title)
                .join(' › ')}{' '}
              · {props.onEdit ? 'Double-click to edit' : 'Click for details'}
            </small>
          </div>
        )}
      </Show>
    </div>
  );
}

/**
 * Marks records that appeared since the previous snapshot: a short "new" state on
 * visible cards, and a per-branch count for arrivals hidden under collapsed nodes
 * until the branch is expanded. User-created nodes carry '*' and are not announced.
 */
function createChangeCues<N extends MapNode>(
  records: () => N[],
  key: () => string | undefined,
  shown: () => ReadonlySet<string>,
) {
  const [fresh, setFresh] = createSignal<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let seen: Set<string> | undefined;
  let seenKey = untrack(key);
  const without = (set: ReadonlySet<string>, drop: (id: string) => boolean) =>
    [...set].some(drop) ? new Set([...set].filter((id) => !drop(id))) : set;
  function announce(arrived: string[]) {
    setFresh((before) => new Set([...before, ...arrived]));
    const unseen = arrived.filter((id) => !shown().has(id));
    if (unseen.length) setHidden((before) => new Set([...before, ...unseen]));
    const timer = setTimeout(() => {
      timers.delete(timer);
      setFresh((before) => without(before, (id) => arrived.includes(id)));
    }, 3000);
    timers.add(timer);
  }
  createEffect(() => {
    const current = records();
    const ids = new Set(current.map((record) => record.id));
    const sameDocument = seen !== undefined && key() === seenKey;
    const arrived = sameDocument
      ? current.filter((r) => !seen?.has(r.id) && !r.userEdited?.includes('*')).map((r) => r.id)
      : [];
    seen = ids;
    seenKey = key();
    untrack(() => {
      if (!sameDocument) {
        timers.forEach(clearTimeout);
        timers.clear();
        setFresh(new Set<string>());
        setHidden(new Set<string>());
      }
      setHidden((before) => without(before, (id) => !ids.has(id)));
      if (arrived.length) announce(arrived);
    });
  });
  // Expanding a branch reveals its arrivals; the count is no longer needed.
  createEffect(() => {
    const visible = shown();
    setHidden((before) => without(before, (id) => visible.has(id)));
  });
  onCleanup(() => timers.forEach(clearTimeout));
  return {
    fresh,
    hiddenBelow: (id: string) =>
      [...hidden()].filter((hid) => nodeTrail(records(), hid).some((a) => a.id === id)).length,
  };
}
