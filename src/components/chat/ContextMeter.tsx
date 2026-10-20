import { Show } from 'solid-js';
import type { AgentChatState } from '../../../electron/shared/agent-chat-types';

const compactTokens = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function tokenSummary(state: AgentChatState): string {
  const usage = state.tokenUsage;
  if (!usage) return '';
  return ` Session: ${usage.totalTokens.toLocaleString()} tokens · ${usage.inputTokens.toLocaleString()} input (including cache) · ${usage.outputTokens.toLocaleString()} output, ${usage.scope === 'connection' ? 'since this chat connected' : 'for this conversation'}.`;
}

/** How full the context window is: a ring, joined by the percentage once it runs
 *  short, with the exact figures and session token usage on hover. Absent until the
 *  provider reports it. */
export function ContextMeter(props: { state: AgentChatState }) {
  return (
    <Show when={props.state.contextUsage}>
      {(usage) => {
        const share = () => usage().usedTokens / usage().maxTokens;
        const title = () => {
          const { usedTokens, maxTokens } = usage();
          const remaining = compactTokens.format(Math.max(0, maxTokens - usedTokens));
          return `Context: ${usedTokens.toLocaleString()} of ${maxTokens.toLocaleString()} tokens used, ${remaining} left. Latest provider-reported estimate; the window may reflect an automatic compaction limit.${tokenSummary(props.state)}`;
        };
        return (
          <span
            class="chat-context-meter"
            role="meter"
            aria-label="Context window usage"
            aria-valuemin={0}
            aria-valuemax={usage().maxTokens}
            aria-valuenow={Math.min(usage().usedTokens, usage().maxTokens)}
            aria-valuetext={title()}
            title={title()}
            data-level={share() >= 1 ? 'full' : share() >= 0.9 ? 'high' : 'normal'}
          >
            <svg class="chat-context-meter-ring" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
              <circle
                cx="8"
                cy="8"
                r="6"
                pathLength="100"
                stroke-dasharray={`${Math.min(100, share() * 100)} 100`}
              />
            </svg>
            <Show when={share() >= 0.9}>{Math.round(share() * 100)}%</Show>
          </span>
        );
      }}
    </Show>
  );
}
