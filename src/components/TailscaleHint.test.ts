import { describe, expect, it } from 'vitest';

import { tailscaleHint } from './TailscaleHint';

describe('tailscaleHint', () => {
  it('offers the login page of a logged-out computer', () => {
    expect(
      tailscaleHint({ state: 'needs-login', loginUrl: 'https://login.tailscale.com/a/abc' }),
    ).toMatchObject({
      text: 'Logged out',
      action: { label: 'Log in', url: 'https://login.tailscale.com/a/abc' },
    });
  });

  it('points to the Tailscale app when no login link is offered', () => {
    const hint = tailscaleHint({ state: 'needs-login', loginUrl: null });
    expect(hint.action).toBeUndefined();
    expect(hint.title).toContain('sudo tailscale up');
  });

  it('links to the download page when Tailscale is missing', () => {
    expect(tailscaleHint({ state: 'not-installed' }).action?.url).toBe(
      'https://tailscale.com/download',
    );
  });

  it('names stopped and unreachable states without an action', () => {
    expect(tailscaleHint({ state: 'stopped' })).toMatchObject({ text: 'Turned off' });
    expect(tailscaleHint({ state: 'not-running' })).toMatchObject({ text: 'Not running' });
    expect(tailscaleHint({ state: 'needs-approval' }).text).toBe('Awaiting approval');
  });

  it('says it is waiting for the address once Tailscale runs', () => {
    expect(tailscaleHint({ state: 'running' }).text).toBe('Waiting for address');
  });

  it('falls back to Not detected while unknown or still loading', () => {
    expect(tailscaleHint(null).text).toBe('Not detected');
    expect(tailscaleHint({ state: 'unknown' }).text).toBe('Not detected');
  });
});
