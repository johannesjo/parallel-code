import { createEffect, createMemo, on } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { computeAttentionEntries } from '../store/sidebar-attention';
import { invoke } from './ipc';
import { warn as logWarn } from './log';

/** How many tasks wait in the sidebar's Needs-you list; several reasons on one task count once. */
export function attentionTaskCount(): number {
  return new Set(computeAttentionEntries().map((entry) => entry.taskId)).size;
}

// Windows shows no badge count, only a small overlay icon, so the count is drawn here,
// in fixed colours: the taskbar sits outside the app's theme.
function overlayIcon(count: number): string | undefined {
  if (!navigator.userAgent.includes('Windows')) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = '#e5484d';
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count > 9 ? '9+' : String(count), 16, 17);
  return canvas.toDataURL('image/png');
}

/** Keeps the dock, launcher or taskbar badge at the Needs-you count while the app runs. */
export function syncAttentionBadge(): void {
  // A memo, so the badge is set when the count changes, not on every list update.
  const count = createMemo(attentionTaskCount);
  createEffect(
    on(count, (count) => {
      const overlay = count > 0 ? overlayIcon(count) : undefined;
      invoke(IPC.SetAttentionBadge, { count, ...(overlay ? { overlay } : {}) }).catch(
        (err: unknown) => logWarn('attention-badge', 'badge update failed', { err }),
      );
    }),
  );
}
