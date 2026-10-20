import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { AgentChatState } from '../../../electron/shared/agent-chat-types';

const stepMarks = { completed: '✓', in_progress: '→', pending: '○' };

/** The agent's plan and what it is doing right now, above the composer. */
export function Progress(props: { state: AgentChatState }) {
  const [now, setNow] = createSignal(Date.now());
  const working = () => props.state.status === 'working';
  createEffect(() => {
    if (!working()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const running = () => props.state.items.findLast((item) => item.activity?.status === 'running');
  const elapsed = () =>
    props.state.startedAt
      ? Math.max(0, Math.floor((now() - props.state.startedAt) / 1000))
      : undefined;
  const completed = () =>
    props.state.plan?.filter((step) => step.status === 'completed').length ?? 0;
  return (
    <>
      <Show when={props.state.plan?.length}>
        <details class="chat-plan">
          <summary>
            Plan · {completed()}/{props.state.plan?.length} complete
          </summary>
          <ol>
            <For each={props.state.plan}>
              {(step) => (
                <li data-status={step.status}>
                  <span>{stepMarks[step.status]}</span> {step.step}
                </li>
              )}
            </For>
          </ol>
        </details>
      </Show>
      <Show when={working() || props.state.interrupted}>
        <div class="chat-progress">
          <Show when={working() && !props.state.requests.length}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
          {/* The clock stays outside the live region, or it is re-announced every second. */}
          <span role="status">
            {props.state.requests.length
              ? 'Waiting for your input'
              : working()
                ? running()?.activity?.label || 'Working…'
                : 'Response stopped'}
          </span>
          <Show when={working() && elapsed() !== undefined}>
            <time>
              {Math.floor((elapsed() ?? 0) / 60)}:{String((elapsed() ?? 0) % 60).padStart(2, '0')}
            </time>
          </Show>
        </div>
      </Show>
    </>
  );
}
