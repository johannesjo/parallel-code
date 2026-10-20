import { For, Show } from 'solid-js';
import { issueCategories } from '../../electron/shared/github-triage';
import type { GitHubIssueSummary } from '../ipc/types';

const LABELS: Record<string, string> = {
  issue: 'Issue',
  bug: 'Bug',
  feature: 'Feature',
  discussion: 'Discussion',
  pr: 'PR',
};
export function GitHubItemBadges(props: { item: GitHubIssueSummary }) {
  return (
    <span class="github-item-badges">
      <For each={issueCategories(props.item)}>
        {(kind) => (
          <span
            class={`github-item-kind ${kind}`}
            title={
              props.item.issueType
                ? `GitHub type: ${props.item.issueType}`
                : 'Based on GitHub item type and repository labels'
            }
          >
            {LABELS[kind]}
          </span>
        )}
      </For>
      <Show when={props.item.isDraft}>
        <span class="github-item-kind">Draft</span>
      </Show>
    </span>
  );
}
