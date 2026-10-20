import { createSignal, Show } from 'solid-js';
import { applyConnectionString } from './auth';

interface ConnectScreenProps {
  onConnected: () => void;
}

export function ConnectScreen(props: ConnectScreenProps) {
  const [input, setInput] = createSignal('');
  const [error, setError] = createSignal('');
  function handleSubmit(e: Event) {
    e.preventDefault();
    const result = applyConnectionString(input());
    if (result === 'invalid') {
      setError('Paste the full connection link from Connect Phone on your computer.');
      return;
    }
    setError('');
    if (result === 'stored') props.onConnected();
  }
  return (
    <main class="mobile-screen mobile-setup">
      <div class="mobile-setup-inner">
        <ol class="mobile-steps" aria-label="Phone setup">
          <li class="current" aria-current="step">
            1. Connect
          </li>
          <li>2. Authorize</li>
          <li>3. Ready</li>
        </ol>
        <div>
          <h1>Your agents, within reach</h1>
          <p>
            Open <strong>Connect Phone</strong> in Parallel Code on your computer and scan its QR
            code with your phone’s camera.
          </p>
        </div>
        <p>
          Already connected before? If your computer restarted or its address changed, scan the
          fresh QR code. Your saved drafts will still be here at this address.
        </p>
        <form class="mobile-form" onSubmit={handleSubmit}>
          <label>
            Or paste the connection link
            <input
              class="mobile-input"
              type="url"
              inputmode="url"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              placeholder="http://…/?token=…"
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
            />
          </label>
          <Show when={error()}>
            <p class="mobile-error" role="alert">
              {error()}
            </p>
          </Show>
          <button class="mobile-button primary" type="submit" disabled={!input().trim()}>
            Connect to computer
          </button>
        </form>
        <p class="muted">Keep both devices on the same WiFi or Tailscale network.</p>
      </div>
    </main>
  );
}
