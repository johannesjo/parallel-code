import { For, Show } from 'solid-js';
import { produce } from 'solid-js/store';
import { fillsOnItsOwn, withProjectSetting } from '../../../lib/cards';
import { store } from '../../../store/store';
import { CardBarPins } from './CardBarPins';
import type { DraftProps } from './CardSourceFields';

/** Where the card shows: in which projects, and beyond the cards themselves. */
export function CardPlacesFields(props: DraftProps) {
  // Replaced, not merged: a store setter would keep an override the helper dropped.
  function setProjectOn(projectId: string, on: boolean) {
    const projects = withProjectSetting(props.draft, projectId, on);
    props.setDraft(
      produce((d) => {
        d.projects = projects;
      }),
    );
  }
  function setSlotPinned(slotId: string, on: boolean) {
    const rest = (props.draft.pinned ?? []).filter((id) => id !== slotId);
    const next = on ? [...rest, slotId] : rest;
    props.setDraft('pinned', next.length ? next : undefined);
  }
  return (
    <>
      <div class="card-editor-field" role="group" aria-label="Projects">
        <span class="card-editor-label">Projects</span>
        <span class="card-editor-inputs">
          <For each={store.projects}>
            {(project) => (
              <label>
                <input
                  type="checkbox"
                  checked={props.draft.projects?.[project.id] ?? props.draft.enabled}
                  onChange={(e) => setProjectOn(project.id, e.currentTarget.checked)}
                />
                {project.name}
              </label>
            )}
          </For>
        </span>
      </div>
      <div class="card-editor-field" role="group" aria-label="In the bar below the title">
        <span class="card-editor-label">Bar below title</span>
        <span class="card-editor-inputs">
          <CardBarPins
            card={props.draft}
            onSummary={(on) => props.setDraft('mini', on || undefined)}
            onSlot={setSlotPinned}
          />
        </span>
      </div>
      {/* Confidence has its own place in Finish, the review. */}
      <Show when={!props.draft.builtIn}>
        <div class="card-editor-field" role="group" aria-label="Also shown">
          <span class="card-editor-label">Also shown</span>
          <span class="card-editor-inputs">
            <label>
              <input
                type="checkbox"
                checked={!!props.draft.showAtFinish}
                onChange={(e) =>
                  props.setDraft('showAtFinish', e.currentTarget.checked || undefined)
                }
              />
              In the Finish dialog
            </label>
          </span>
        </div>
      </Show>
      {/* A card that fills only when run would stay hidden, its Run button with it. */}
      <Show when={!props.draft.builtIn && fillsOnItsOwn(props.draft.source)}>
        <div class="card-editor-field" role="group" aria-label="While empty">
          <span class="card-editor-label">While empty</span>
          <span class="card-editor-inputs">
            <label>
              <input
                type="checkbox"
                checked={!!props.draft.hideEmpty}
                onChange={(e) => props.setDraft('hideEmpty', e.currentTarget.checked || undefined)}
              />
              Hide until it has values
            </label>
          </span>
        </div>
      </Show>
    </>
  );
}
