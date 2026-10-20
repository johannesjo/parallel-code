import { For, Show, createSignal } from 'solid-js';
import { theme } from '../lib/theme';
import { store } from '../store/store';
import type { ResourceGroup, ResourceSnapshot } from '../ipc/types';
import { formatBytes, formatCpu, groupKey, groupLabel, snapshotTotals } from './resources-format';

const numberCell = { width: '64px', 'text-align': 'right', 'flex-shrink': '0' } as const;
const rowStyle = { display: 'flex', 'align-items': 'center', gap: '8px', padding: '3px 6px' };

function GroupRow(props: {
  group: ResourceGroup;
  label: string;
  cpuCount: number;
  open: boolean;
  onToggle: () => void;
}) {
  const open = () => props.open;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open()}
        onClick={() => props.onToggle()}
        style={{
          ...rowStyle,
          width: '100%',
          background: 'none',
          border: 'none',
          color: theme.fg,
          font: 'inherit',
          cursor: 'pointer',
          'text-align': 'left',
        }}
      >
        <span style={{ width: '10px', color: theme.fgSubtle }}>{open() ? '▾' : '▸'}</span>
        <span style={{ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
          {props.label}
        </span>
        <span style={numberCell}>{formatCpu(props.group.cpuPercent, props.cpuCount)}</span>
        <span style={numberCell}>{formatBytes(props.group.memoryBytes)}</span>
      </button>
      <Show when={open()}>
        <For each={props.group.processes}>
          {(proc) => (
            <div style={{ ...rowStyle, 'padding-left': '24px', color: theme.fgMuted }}>
              <span style={{ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                {proc.name} <span style={{ color: theme.fgSubtle }}>{proc.pid}</span>
              </span>
              <span style={numberCell}>{formatCpu(proc.cpuPercent, props.cpuCount)}</span>
              <span style={numberCell}>{formatBytes(proc.memoryBytes)}</span>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

/** Groups sorted by CPU, expandable into their processes, with a machine total. */
export function ResourcesBreakdown(props: {
  snapshot: ResourceSnapshot | null;
  error: string | null;
}) {
  const groups = () =>
    [...(props.snapshot?.groups ?? [])].sort((a, b) => b.cpuPercent - a.cpuPercent);
  // Rows are rebuilt on every poll, so expansion lives here, keyed by group.
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <>
      <div
        style={{
          ...rowStyle,
          'padding-left': '24px',
          color: theme.fgSubtle,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
          'font-weight': '600',
        }}
      >
        <span style={{ flex: '1' }}>Resources</span>
        <span style={numberCell}>CPU</span>
        <span style={numberCell}>Memory</span>
      </div>
      <Show when={props.error}>
        <div style={{ ...rowStyle, color: theme.warning }}>{props.error}</div>
      </Show>
      <Show when={props.snapshot} fallback={<div style={rowStyle}>Measuring…</div>}>
        {(snapshot) => (
          <>
            <div style={{ overflow: 'auto', 'max-height': '50vh' }}>
              <For each={groups()}>
                {(group) => (
                  <GroupRow
                    group={group}
                    label={groupLabel(group, store)}
                    cpuCount={snapshot().cpuCount}
                    open={expanded().has(groupKey(group))}
                    onToggle={() => toggle(groupKey(group))}
                  />
                )}
              </For>
            </div>
            <div
              style={{ ...rowStyle, 'border-top': `1px solid ${theme.border}`, color: theme.fg }}
            >
              <span style={{ flex: '1', color: theme.fgSubtle }}>
                Total · CPU of all {snapshot().cpuCount} cores
              </span>
              <span style={numberCell}>
                {formatCpu(snapshotTotals(snapshot()).cpuPercent, snapshot().cpuCount)}
              </span>
              <span style={numberCell}>{formatBytes(snapshotTotals(snapshot()).memoryBytes)}</span>
            </div>
          </>
        )}
      </Show>
    </>
  );
}
