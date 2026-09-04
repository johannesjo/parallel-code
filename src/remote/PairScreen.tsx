import { createSignal, Show } from 'solid-js';
import { verifyPairingPin } from './api';
import { setPairedToken } from './auth';

interface PairScreenProps {
  onPaired: () => void;
  onCancel: () => void;
}

/**
 * Shown before a phone may type into a terminal, save notes, or create tasks.
 * The user opens Connect Phone on the desktop, taps "Pair a device", and types
 * the 6-digit code shown there.
 */
export function PairScreen(props: PairScreenProps) {
  const [pin, setPin] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const code = pin().trim();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from the desktop app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await verifyPairingPin(code);
      setPairedToken(token);
      props.onPaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'justify-content': 'center',
        height: '100%',
        padding: '24px',
        gap: '20px',
        'text-align': 'center',
        background: '#0b0f14',
        color: '#678197',
      }}
    >
      <div>
        <p style={{ 'font-size': '17px', color: '#d7e4f0', 'margin-bottom': '8px' }}>
          Pair this device
        </p>
        <p style={{ 'font-size': '14px', color: '#678197', 'line-height': '1.5' }}>
          Typing into agents, saving notes, and creating tasks need a paired phone. On your
          computer, open <strong>Connect Phone</strong> and tap{' '}
          <strong>Pair a device to type and create tasks</strong>. Enter the 6-digit code below.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '10px',
          width: '100%',
          'max-width': '360px',
        }}
      >
        <input
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength={6}
          placeholder="000000"
          value={pin()}
          onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
          style={{
            width: '100%',
            padding: '12px 14px',
            'font-size': '24px',
            'letter-spacing': '8px',
            'text-align': 'center',
            'font-family': 'monospace',
            background: '#10161d',
            border: '1px solid #223040',
            'border-radius': '8px',
            color: '#d7e4f0',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={pin().length !== 6 || busy()}
          style={{
            padding: '12px 14px',
            'font-size': '15px',
            'font-weight': '600',
            background: pin().length === 6 && !busy() ? '#2ec8ff' : '#1a2430',
            color: pin().length === 6 && !busy() ? '#031018' : '#678197',
            border: 'none',
            'border-radius': '8px',
            cursor: pin().length === 6 && !busy() ? 'pointer' : 'default',
          }}
        >
          {busy() ? 'Pairing…' : 'Pair'}
        </button>
        <Show when={error()}>
          <p style={{ 'font-size': '13px', color: '#fca5a5', margin: '0' }}>{error()}</p>
        </Show>
        <button
          type="button"
          onClick={() => props.onCancel()}
          style={{
            padding: '8px',
            background: 'transparent',
            border: 'none',
            color: '#678197',
            cursor: 'pointer',
            'font-size': '13px',
          }}
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
