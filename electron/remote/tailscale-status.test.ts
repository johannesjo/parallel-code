import { describe, it, expect } from 'vitest';
import { tailscaleStateFromStatus, readTailscaleState } from './tailscale-status.js';

describe('tailscaleStateFromStatus', () => {
  it('offers the login link of a logged-out machine', () => {
    expect(
      tailscaleStateFromStatus({
        BackendState: 'NeedsLogin',
        AuthURL: 'https://login.tailscale.com/a/b274fc834512c',
      }),
    ).toEqual({ state: 'needs-login', loginUrl: 'https://login.tailscale.com/a/b274fc834512c' });
  });

  it('offers no link when the daemon has none, or a non-https one', () => {
    expect(tailscaleStateFromStatus({ BackendState: 'NeedsLogin', AuthURL: '' })).toEqual({
      state: 'needs-login',
      loginUrl: null,
    });
    expect(
      tailscaleStateFromStatus({ BackendState: 'NeedsLogin', AuthURL: 'file:///etc/passwd' }),
    ).toEqual({ state: 'needs-login', loginUrl: null });
  });

  it('maps the other backend states', () => {
    expect(tailscaleStateFromStatus({ BackendState: 'Running' })).toEqual({ state: 'running' });
    expect(tailscaleStateFromStatus({ BackendState: 'Stopped' })).toEqual({ state: 'stopped' });
    expect(tailscaleStateFromStatus({ BackendState: 'NeedsMachineAuth' })).toEqual({
      state: 'needs-approval',
    });
    expect(tailscaleStateFromStatus({ BackendState: 'Starting' })).toEqual({ state: 'unknown' });
    expect(tailscaleStateFromStatus('nonsense')).toEqual({ state: 'unknown' });
  });
});

describe('readTailscaleState', () => {
  const enoent = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });

  it('reports not-installed when no candidate binary exists', async () => {
    const run = async () => Promise.reject(enoent);
    await expect(readTailscaleState(run, ['tailscale', '/opt/tailscale'])).resolves.toEqual({
      state: 'not-installed',
    });
  });

  it('falls back to the next candidate, such as the macOS app bundle', async () => {
    const run = async (bin: string) =>
      bin === 'tailscale' ? Promise.reject(enoent) : '{"BackendState":"Running"}';
    await expect(readTailscaleState(run, ['tailscale', '/opt/tailscale'])).resolves.toEqual({
      state: 'running',
    });
  });

  it('reports not-running when the CLI exists but the daemon does not answer', async () => {
    const run = async () =>
      Promise.reject(
        Object.assign(new Error('failed to connect to local tailscaled'), { code: 1 }),
      );
    await expect(readTailscaleState(run, ['tailscale'])).resolves.toEqual({
      state: 'not-running',
    });
  });

  it('still reads the status when the CLI prints it but exits non-zero', async () => {
    const run = async () =>
      Promise.reject(
        Object.assign(new Error('exit 1'), { code: 1, stdout: '{"BackendState":"Stopped"}' }),
      );
    await expect(readTailscaleState(run, ['tailscale'])).resolves.toEqual({ state: 'stopped' });
  });

  it('reports unknown when the output is not JSON', async () => {
    const run = async () => 'Logged out.';
    await expect(readTailscaleState(run, ['tailscale'])).resolves.toEqual({ state: 'unknown' });
  });
});
