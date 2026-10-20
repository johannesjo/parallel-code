import { createUniqueId, For, Show } from 'solid-js';
import { reasoningProfiles, type ReasoningProfile } from '../investigation/profiles';
import { PlayIcon, PlusIcon } from './icons';

interface Props {
  /** `new` archives an existing report; `empty` starts the task's first map. */
  mode: 'empty' | 'new';
  profile: ReasoningProfile;
  onProfile: (profile: ReasoningProfile) => void;
  restartFirst: boolean;
  onRestartFirst: (value: boolean) => void;
  agentName: string;
  /** Why the request cannot be sent right now; the form still shows it while the request may queue. */
  blocker: string;
  canStart: boolean;
  queued: boolean;
  sending: boolean;
  error: string;
  onStart: () => void;
  onCancel: () => void;
}

/** The workflow choice belongs to starting a map, so it lives here rather than in the live status bar. */
export function ReasoningSetup(props: Props) {
  const group = createUniqueId();
  const busy = () => props.sending || props.queued;
  return (
    <section class="reasoning-setup" aria-labelledby={`${group}-title`}>
      <h3 id={`${group}-title`}>{props.mode === 'new' ? 'New map' : 'Reasoning graph'}</h3>
      <p>
        {props.mode === 'new'
          ? 'Starting a new map archives the current map and saved edits, then asks the agent to start a fresh map.'
          : 'No reasoning graph yet. Start a live map below, or ask the agent in chat to open one. It reports goals, hypotheses, evidence, and decisions here while it works.'}
      </p>
      <fieldset disabled={busy()}>
        <legend>Workflow</legend>
        <For each={Object.entries(reasoningProfiles)}>
          {([key, value]) => (
            <label>
              <input
                type="radio"
                name={`${group}-workflow`}
                value={key}
                checked={props.profile === key}
                onChange={() => props.onProfile(key as ReasoningProfile)}
              />
              <strong>{value.label}</strong>
              <span>{value.summary}</span>
            </label>
          )}
        </For>
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={props.restartFirst}
          disabled={busy()}
          onChange={(event) => props.onRestartFirst(event.currentTarget.checked)}
        />
        <span>Restart {props.agentName} first for a clean context. Its conversation is lost.</span>
      </label>
      <div class="reasoning-setup-actions">
        <Show when={!props.queued}>
          <button
            class="investigation-primary btn-with-icon"
            disabled={props.sending || !props.canStart}
            onClick={() => props.onStart()}
          >
            {props.mode === 'new' ? <PlusIcon size={12} /> : <PlayIcon size={12} />}
            {props.sending ? 'Starting…' : props.mode === 'new' ? 'New map…' : 'Start live map'}
          </button>
        </Show>
        <Show when={props.queued}>
          <span role="status">Queued until the agent is ready.</span>
        </Show>
        <Show when={props.queued || props.mode === 'new'}>
          <button onClick={() => props.onCancel()}>Cancel</button>
        </Show>
      </div>
      <Show when={props.blocker && !busy()}>
        <p class="reasoning-setup-blocker">{props.blocker}</p>
      </Show>
      <Show when={props.error}>
        <p class="reasoning-setup-blocker" role="alert">
          {props.error}
        </p>
      </Show>
      <p class="reasoning-setup-hint">
        Or ask the agent in chat, for example “create a reasoning graph for this bug”.
      </p>
    </section>
  );
}
