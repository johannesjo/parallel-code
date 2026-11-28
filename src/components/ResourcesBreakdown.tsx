import { For, Show, createSignal } from 'solid-js';
import { theme } from '../lib/theme';
import { store } from '../store/store';
import type { ResourceGroup, ResourceSnapshot } from '../ipc/types';
import { ActivityIcon, TreeChevronIcon } from './icons';
import { formatBytes, formatCpu, groupKey, groupLabel, snapshotTotals } from './resources-format';

const numberCell = {
  width: '60px',
  'font-family': 'var(--font-mono)',
  'font-variant-numeric': 'tabular-nums',
  'text-align': 'right',
  'flex-shrink': '0',
} as const;
const rowStyle = { display: 'flex', 'align-items': 'center', gap: '8px', padding: '4px 8px' };

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
        class="resource-group-toggle"
        aria-expanded={open()}
        onClick={() => props.onToggle()}
        style={{
          ...rowStyle,
          width: '100%',
          border: 'none',
          color: theme.fg,
          font: 'inherit',
          cursor: 'pointer',
          'text-align': 'left',
        }}
      >
        <TreeChevronIcon size={10} />
        <span
          title={props.label}
          style={{ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis' }}
        >
          {props.label}
        </span>
        <span style={numberCell}>{formatCpu(props.group.cpuPercent, props.cpuCount)}</span>
        <span style={numberCell}>{formatBytes(props.group.memoryBytes)}</span>
      </button>
      <Show when={open()}>
        <For each={props.group.processes}>
          {(proc) => (
            <div class="resource-process-row" style={rowStyle}>
              <span
                title={`${proc.name} · PID ${proc.pid}`}
                style={{ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis' }}
              >
                {proc.name} <span style={{ color: theme.fgSubtle }}>{proc.pid}</span>
              </span>
              <span style={numberCell}>{formatCpu(proc.cpuPercent, props.cpuCount)}</span>
              <span style={numberCell}>{formatBytes(proc.memoryBytes)}</span>
            </div>
          )}
        </For>
        {/* Last, and present on every sample, so the line does not jump as commands come and go. */}
        <Show when={props.group.exitedCpuPercent !== undefined}>
          <div
            title="Commands that started and exited since the last sample: hooks, short shell and test runs"
            class="resource-process-row"
            style={rowStyle}
          >
            <span style={{ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
              finished commands
            </span>
            <span style={numberCell}>
              {formatCpu(props.group.exitedCpuPercent ?? 0, props.cpuCount)}
            </span>
            <span style={numberCell} />
          </div>
        </Show>
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
    <div class="resource-table">
      <div class="resource-heading" style={rowStyle}>
        <span>
          <ActivityIcon size={14} />
          Resources
        </span>
        <span style={numberCell}>CPU</span>
        <span style={numberCell}>Memory</span>
      </div>
      <Show when={props.error}>
        <div
          style={{
            ...rowStyle,
            color: theme.warning,
            'white-space': 'normal',
            'overflow-wrap': 'anywhere',
          }}
        >
          {props.error}
        </div>
      </Show>
      <Show when={props.snapshot} fallback={<div style={rowStyle}>Measuring…</div>}>
        {(snapshot) => (
          <>
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
            <div class="resource-total" style={rowStyle}>
              <span style={{ flex: '1', 'min-width': '0', 'white-space': 'normal' }}>
                Total <small>CPU across {snapshot().cpuCount} cores</small>
              </span>
              <span style={numberCell}>
                {formatCpu(snapshotTotals(snapshot()).cpuPercent, snapshot().cpuCount)}
              </span>
              <span style={numberCell}>{formatBytes(snapshotTotals(snapshot()).memoryBytes)}</span>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
