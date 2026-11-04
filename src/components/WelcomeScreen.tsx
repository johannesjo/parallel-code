import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { isAgentInstalled } from '../lib/default-agent';
import * as log from '../lib/log';
import { agentsLoadFailed, agentsLoaded, loadAgents } from '../store/agents';
import { store } from '../store/core';
import { showNotification } from '../store/notification';
import { pickAndAddProject } from '../store/projects';
import { AppLogo } from './icons';
import './welcome.css';

const STEPS = [
  { title: 'Link a project', detail: 'Once for each codebase.' },
  { title: 'Start tasks', detail: 'Each gets its own agent and branch.' },
  { title: 'Review and merge', detail: 'The board shows what needs you.' },
];

/** "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Which agents tasks can use; re-detected on return, so a CLI installed meanwhile shows up. */
function AgentsLine() {
  const installed = () => store.availableAgents.filter(isAgentInstalled).map((agent) => agent.name);
  const redetect = () => {
    if (installed().length > 0) return;
    loadAgents().catch((err: unknown) => log.error('agents', 'Agent re-detection failed', err));
  };
  window.addEventListener('focus', redetect);
  onCleanup(() => window.removeEventListener('focus', redetect));
  return (
    // Reserves its line while agents load, so nothing above it moves. A failed
    // listing says nothing about what is installed, so it stays blank too.
    <p class="welcome-agents" classList={{ pending: !agentsLoaded() || agentsLoadFailed() }}>
      <Show
        when={installed().length > 0}
        fallback="No coding agent found yet. Install one, such as Claude Code or Codex CLI, to run tasks."
      >
        Found {listNames(installed())}.
      </Show>
    </p>
  );
}

/**
 * The first screen of a new install, whatever view is selected: the one step
 * that starts everything, with no other app UI around it. It gives way to the
 * workspace as soon as a project is linked.
 */
export function WelcomeScreen() {
  const [linking, setLinking] = createSignal(false);
  let action: HTMLButtonElement | undefined;
  // Enter links right away; nothing else on the screen competes for the keyboard.
  onMount(() => action?.focus());

  const link = async () => {
    setLinking(true);
    try {
      await pickAndAddProject();
    } catch (err) {
      showNotification(`Couldn't link the project: ${log.errMessage(err)}`);
    } finally {
      setLinking(false);
    }
  };

  return (
    <main class="welcome" aria-labelledby="welcome-title">
      <div class="welcome-content">
        <AppLogo class="welcome-logo" />
        <h1 id="welcome-title">Parallel Code</h1>
        <p class="welcome-lead">
          Run several coding agents at once, each in its own Git worktree, so they never step on
          each other.
        </p>
        <button
          ref={action}
          type="button"
          class="welcome-action"
          disabled={linking()}
          onClick={() => void link()}
        >
          Link a project folder…
        </button>
        <p class="welcome-hint">Any folder with your code. A Git repository works best.</p>
        <ol class="welcome-steps" aria-label="How it works">
          <For each={STEPS}>
            {(step) => (
              <li>
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </li>
            )}
          </For>
        </ol>
        <AgentsLine />
      </div>
    </main>
  );
}
