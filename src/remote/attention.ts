// Maps a RemoteAgent's status onto a mobile-friendly label + colour, mirroring
// the desktop's StatusDot palette so the overview reads the same on both.
//
// `attention` (renderer-derived) is the primary signal. The status==='exited'
// arm is a defensive fallback: the agent list is currently built only from live
// PTY sessions, so exited agents drop out rather than reaching here — but the
// branch keeps the label correct if that wiring ever changes.

import type { RemoteAgent, RemoteAttentionState } from '../../electron/remote/protocol';

export interface StatusDisplay {
  label: string;
  color: string;
  /** Draw a glow ring — reserved for states that want the user's attention. */
  glow: boolean;
}

// Colours chosen to match the mobile SPA's existing palette and the desktop
// StatusDot: amber = needs input, blue = working, red = error, purple = review,
// green = ready, grey = idle/exited.
const AMBER = '#ffc569';
const BLUE = '#2ec8ff';
const RED = '#ff5f73';
const PURPLE = '#c084fc';
const GREEN = '#2fd198';
const GREY = '#678197';

const BY_ATTENTION: Partial<Record<RemoteAttentionState, StatusDisplay>> = {
  needs_input: { label: 'Needs input', color: AMBER, glow: true },
  active: { label: 'Working', color: BLUE, glow: true },
  shell_busy: { label: 'Terminal busy', color: GREY, glow: false },
  error: { label: 'Error', color: RED, glow: true },
  review: { label: 'Review', color: PURPLE, glow: true },
  ready: { label: 'Ready', color: GREEN, glow: false },
};

type StatusInput = Pick<RemoteAgent, 'status' | 'attention' | 'collapsed' | 'ci'>;

/** Failed PR checks need the user once the agent has stopped; a busier state still wins. */
export function isCiFailed(agent: Omit<StatusInput, 'status'>): boolean {
  return (
    !agent.collapsed &&
    agent.ci === 'failure' &&
    (agent.attention === 'idle' || agent.attention === 'ready')
  );
}

/** The tasks the overview counts, files and filters under "Needs you". */
export function needsYou(agent: Omit<StatusInput, 'status'>): boolean {
  return agent.attention === 'needs_input' || agent.attention === 'error' || isCiFailed(agent);
}

/** `ready` only says nothing failed; the PR checks say whether it can merge yet. */
const READY_BY_CI: Record<NonNullable<RemoteAgent['ci']>, string> = {
  success: 'Ready to merge',
  pending: 'CI running',
  failure: 'Ready',
};

export function agentStatusDisplay(agent: StatusInput): StatusDisplay {
  if (agent.collapsed) return { label: 'Minimized', color: GREY, glow: false };
  if (isCiFailed(agent)) return { label: 'CI failed', color: RED, glow: true };
  if (agent.attention === 'ready' && agent.ci)
    return { label: READY_BY_CI[agent.ci], color: GREEN, glow: false };
  const known = BY_ATTENTION[agent.attention];
  if (known) return known;
  // attention is 'idle' (or unknown): distinguish a live idle agent from an
  // exited one so the overview doesn't mislabel a finished process as idle.
  return agent.status === 'exited'
    ? { label: 'Exited', color: GREY, glow: false }
    : { label: 'Idle', color: GREY, glow: false };
}
