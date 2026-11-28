import { createSignal, For, onCleanup, Show } from 'solid-js';
import {
  BRIEF_MODELS,
  isBriefModelId,
  type BriefModelId,
} from '../../electron/shared/task-name-model';
import type { ResourceSnapshot } from '../ipc/types';
import { errMessage } from '../lib/log';
import { startModelRequest, type ModelRequest } from '../lib/model-request';
import { store } from '../store/store';
import { SparkleIcon } from './icons';
import { formatBytes, formatCpu, groupLabel, snapshotTotals } from './resources-format';

interface Usage {
  cpuPercent: number;
  memoryBytes: number;
}

// Keep the prompt small even when there are many terminals and worker processes.
function largestConsumers<T extends Usage>(rows: T[]): T[] {
  const top = (key: keyof Usage) => [...rows].sort((a, b) => b[key] - a[key]).slice(0, 5);
  return [...new Set([...top('cpuPercent'), ...top('memoryBytes')])];
}

function analysisPrompt(sample: ResourceSnapshot): string {
  const usage = (row: Usage) => ({
    cpu: formatCpu(row.cpuPercent, sample.cpuCount),
    memory: formatBytes(row.memoryBytes),
  });
  const groups = sample.groups.map((group) => ({
    ...group,
    label: groupLabel(group, store).slice(0, 160),
  }));
  const processes = groups.flatMap((g) => g.processes.map((p) => ({ ...p, group: g.label })));
  return JSON.stringify({
    sampledAt: new Date(sample.sampledAt).toISOString(),
    cores: sample.cpuCount,
    machineMemory: formatBytes(sample.totalMemoryBytes),
    parallelCodeTotal: usage(snapshotTotals(sample)),
    topGroups: largestConsumers(groups).map((g) => ({
      group: g.label,
      ...usage(g),
      finishedCommandsCpu:
        g.exitedCpuPercent === undefined
          ? undefined
          : formatCpu(g.exitedCpuPercent, sample.cpuCount),
    })),
    topProcesses: largestConsumers(processes).map((p) => ({
      group: p.group,
      name: p.name.slice(0, 160),
      pid: p.pid,
      ...usage(p),
    })),
  });
}

export interface ResourceAnalysisResult {
  text: string;
  sampledAt: number;
}

export function ResourceAnalysis(props: {
  snapshot: ResourceSnapshot | null;
  model: BriefModelId;
  onModelChange: (model: BriefModelId) => void;
  result: ResourceAnalysisResult | undefined;
  onResult: (result: ResourceAnalysisResult) => void;
}) {
  const [running, setRunning] = createSignal(false);
  const [error, setError] = createSignal('');
  let request: ModelRequest | undefined;
  onCleanup(() => {
    request?.cancel();
    request = undefined;
  });

  const disabled = () => running() || !props.snapshot?.groups.length;

  async function analyse() {
    const sample = props.snapshot;
    if (!sample?.groups.length || running()) return;
    setRunning(true);
    setError('');
    try {
      request = startModelRequest({
        prompt: analysisPrompt(sample),
        purpose: 'resources',
        projectId: undefined,
        agentEnvFiles: store.agentEnvFiles,
        settings: BRIEF_MODELS[props.model],
      });
      const text = (await request.result).trim();
      if (!request) return;
      if (!text) throw new Error('The model returned an empty analysis.');
      props.onResult({ text, sampledAt: sample.sampledAt });
    } catch (err) {
      setError(errMessage(err));
    } finally {
      request = undefined;
      setRunning(false);
    }
  }

  return (
    <div class="resource-analysis">
      <div class="resource-analysis-controls">
        <button
          type="button"
          class="btn-with-icon"
          aria-busy={running()}
          disabled={disabled()}
          title={`Send this sample’s task names, process names, PIDs, CPU and memory to ${BRIEF_MODELS[props.model].label}`}
          onClick={() => void analyse()}
        >
          <Show when={running()} fallback={<SparkleIcon size={12} />}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
          {running() ? 'Analysing…' : 'Analyse with AI'}
        </button>
        <select
          aria-label="Resource analysis model"
          title="Resource analysis model"
          value={props.model}
          disabled={running()}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (isBriefModelId(value)) props.onModelChange(value);
          }}
        >
          <For each={Object.entries(BRIEF_MODELS)}>
            {([id, model]) => <option value={id}>{model.label.split(' (')[0]}</option>}
          </For>
        </select>
      </div>
      <Show when={error()}>
        <div class="resource-analysis-message" role="alert">
          {error()}
        </div>
      </Show>
      <Show when={props.result}>
        {(result) => (
          <div class="resource-analysis-message" role="status">
            {result().text}
            <div class="resource-sample-time">
              Sample at {new Date(result().sampledAt).toLocaleTimeString()}
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
