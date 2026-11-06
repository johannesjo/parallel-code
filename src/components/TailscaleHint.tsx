// src/components/TailscaleHint.tsx

import { Show, createResource, onCleanup } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { TailscaleState } from '../../electron/ipc/shared-types';
import { theme } from '../lib/theme';

interface Hint {
  text: string;
  /** Longer explanation shown on hover. */
  title?: string;
  action?: { label: string; url: string };
}

const LOGIN_ELSEWHERE = 'Log in from the Tailscale app, or run `sudo tailscale up` on Linux.';

/** Why the Tailscale option is unavailable, and what to do about it. Null while loading. */
export function tailscaleHint(state: TailscaleState | null): Hint {
  switch (state?.state) {
    case 'needs-login':
      return state.loginUrl
        ? {
            text: 'Logged out',
            title: 'Opens Tailscale’s login page in your browser.',
            action: { label: 'Log in', url: state.loginUrl },
          }
        : { text: 'Logged out', title: LOGIN_ELSEWHERE };
    case 'not-installed':
      return {
        text: 'Not installed',
        action: { label: 'Get it', url: 'https://tailscale.com/download' },
      };
    case 'stopped':
      return { text: 'Turned off', title: 'Turn Tailscale on in its app, or run `tailscale up`.' };
    case 'not-running':
      return { text: 'Not running', title: 'Start the Tailscale app or its service.' };
    case 'needs-approval':
      return {
        text: 'Awaiting approval',
        title: 'An admin of your tailnet must approve this computer.',
      };
    case 'running':
      // Briefly true right after logging in, until the modal's poll finds the 100.x address.
      return {
        text: 'Waiting for address',
        title: 'Tailscale is on; its address has not appeared yet.',
      };
    default:
      return { text: 'Not detected' };
  }
}

/** Shown under the Tailscale option while this computer has no Tailscale address. */
export function TailscaleHint() {
  const [state, { refetch }] = createResource(() => invoke<TailscaleState>(IPC.GetTailscaleState));
  // Logging in happens in the browser or Tailscale's app, so reread on return.
  const onFocus = () => void refetch();
  window.addEventListener('focus', onFocus);
  onCleanup(() => window.removeEventListener('focus', onFocus));
  const hint = () => tailscaleHint(state.error ? null : (state.latest ?? null));
  return (
    <span
      // Hidden, not removed, while loading so the pill row keeps its width.
      style={{
        'font-size': '11px',
        color: theme.fgSubtle,
        visibility:
          state.state === 'unresolved' || state.state === 'pending' ? 'hidden' : 'visible',
      }}
      title={hint().title}
    >
      {hint().text}
      <Show when={hint().action}>
        {(action) => (
          <>
            {' · '}
            <a
              href={action().url}
              style={{ color: 'inherit' }}
              onClick={(e) => {
                e.preventDefault();
                void invoke(IPC.ShellOpenExternal, { url: action().url });
              }}
            >
              {action().label}
            </a>
          </>
        )}
      </Show>
    </span>
  );
}
