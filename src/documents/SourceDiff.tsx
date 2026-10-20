import { For, Show } from 'solid-js';
import { parseUnifiedDiff } from '../lib/unified-diff-parser';

/** Compact unified-diff renderer for the source toggle in compare and history. */
export function SourceDiff(props: { raw: string }) {
  const files = () => parseUnifiedDiff(props.raw);
  return (
    <div class="docws-diff">
      <Show when={files().length === 0}>
        <div class="docws-empty">No source changes.</div>
      </Show>
      <For each={files()}>
        {(file) => (
          <div>
            <For each={file.hunks}>
              {(hunk) => (
                <div>
                  <div class="docws-diff-line docws-diff-hunk">
                    @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                  </div>
                  <For each={hunk.lines}>
                    {(line) => (
                      <div
                        class="docws-diff-line"
                        classList={{
                          'docws-diff-add': line.type === 'add',
                          'docws-diff-remove': line.type === 'remove',
                        }}
                      >
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                        {line.content}
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
