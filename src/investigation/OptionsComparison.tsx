import { createMemo, For, Show } from 'solid-js';
import { recordTrail } from './presentation';
import type { InvestigationRecord, Snapshot } from './state';

interface Props {
  snapshot: Snapshot;
  onSelect: (id: string) => void;
}

export function OptionsComparison(props: Props) {
  const groups = createMemo(() => {
    const options = props.snapshot.records.filter((record) => record.kind === 'option');
    const grouped = new Map<string, InvestigationRecord[]>();
    for (const option of options) {
      const parent = option.parent ?? '';
      grouped.set(parent, [...(grouped.get(parent) ?? []), option]);
    }
    return new Map(
      [...grouped].map(([parent, options]) => {
        const ancestors = recordTrail(props.snapshot, parent);
        const criteria = new Set(
          [
            ...ancestors.flatMap((record) => record.criteria ?? []),
            ...options.flatMap((record) => [
              ...(record.criteria ?? []),
              ...(record.evaluations?.map((entry) => entry.criterion) ?? []),
            ]),
          ]
            .map((criterion) => criterion.trim())
            .filter(Boolean),
        );
        return [
          parent,
          { title: ancestors.at(-1)?.title ?? 'Options', options, criteria: [...criteria] },
        ] as const;
      }),
    );
  });

  return (
    <section class="investigation-comparison" aria-label="Option comparison" tabIndex={0}>
      <p>Agent-reported assessments · Select an option for details and sources.</p>
      <For each={[...groups().keys()]}>
        {(parent) => (
          <Show when={groups().get(parent)}>
            {(group) => (
              <div class="investigation-comparison-group">
                <table style={{ width: `${140 + group().options.length * 180}px` }}>
                  <caption>{group().title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Criterion</th>
                      <For each={group().options.map((option) => option.id)}>
                        {(id) => (
                          <Show when={group().options.find((record) => record.id === id)}>
                            {(option) => (
                              <th scope="col">
                                <button data-option-id={id} onClick={() => props.onSelect(id)}>
                                  {option().title}
                                </button>
                                <span class="investigation-comparison-status">
                                  {option().status}
                                </span>
                              </th>
                            )}
                          </Show>
                        )}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Overview</th>
                      <For each={group().options}>
                        {(option) => (
                          <td>
                            <div class="investigation-comparison-summary">{option.detail}</div>
                          </td>
                        )}
                      </For>
                    </tr>
                    <For each={group().criteria}>
                      {(criterion) => (
                        <tr>
                          <th scope="row">{criterion}</th>
                          <For each={group().options}>
                            {(option) => (
                              <td>
                                {option.evaluations?.find(
                                  (entry) => entry.criterion.trim() === criterion,
                                )?.assessment ?? (
                                  <span class="investigation-comparison-missing">Not assessed</span>
                                )}
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <Show when={!group().criteria.length}>
                  <p>No criteria reported for these options yet.</p>
                </Show>
              </div>
            )}
          </Show>
        )}
      </For>
    </section>
  );
}
