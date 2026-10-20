import { createSignal, Show } from 'solid-js';
import { verifyPairingPin } from './api';
import { setPairedToken } from './auth';

interface PairScreenProps {
  onPaired: () => void;
  onCancel: () => void;
}

export function PairScreen(props: PairScreenProps) {
  const [pin, setPin] = createSignal('');
  const [remember, setRemember] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (busy() || !/^\d{6}$/.test(pin())) return;
    setBusy(true);
    setError(null);
    try {
      setPairedToken(await verifyPairingPin(pin(), remember()), remember());
      props.onPaired();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Pairing failed. Try a fresh code from your computer.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="mobile-screen mobile-setup">
      <div class="mobile-setup-inner">
        <ol class="mobile-steps" aria-label="Phone setup">
          <li>1. Connect</li>
          <li class="current" aria-current="step">
            2. Authorize
          </li>
          <li>3. Ready</li>
        </ol>
        <div>
          <h1>Enable replies before you go</h1>
          <p>
            Your phone is connected for viewing. Enter the code from your computer to send messages,
            create tasks, and save notes.
          </p>
        </div>
        <p>
          Your six-digit code is ready in <strong>Connect Phone</strong> on your computer.
        </p>
        <form class="mobile-form" onSubmit={handleSubmit}>
          <label>
            Code from your computer
            <input
              class="mobile-input mobile-pin"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength={6}
              placeholder="000000"
              value={pin()}
              onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
              disabled={busy()}
            />
          </label>
          <label>
            <span>
              <input
                type="checkbox"
                checked={remember()}
                onChange={(e) => setRemember(e.currentTarget.checked)}
                disabled={busy()}
              />{' '}
              Keep this device authenticated
            </span>
            <span>Stay paired after restarting your computer. Use only on a phone you trust.</span>
          </label>
          <Show when={error()}>
            <p class="mobile-error" role="alert">
              {error()}
            </p>
          </Show>
          <button
            class="mobile-button primary"
            type="submit"
            disabled={pin().length !== 6 || busy()}
          >
            {busy() ? 'Authorizing…' : 'Enable replies'}
          </button>
          <button
            class="mobile-button quiet"
            type="button"
            onClick={() => props.onCancel()}
            disabled={busy()}
          >
            Continue viewing only
          </button>
        </form>
      </div>
    </main>
  );
}
