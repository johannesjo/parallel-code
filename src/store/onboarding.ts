import { batch, createSignal } from 'solid-js';
import { store, setStore } from './core';
import { saveState } from './persistence';
import type { FeatureHintId } from '../lib/feature-hints';

/** After a tip goes, the next one waits this long, so tips never chain. */
const COOLDOWN_MS = 60_000;

/** The one tip on screen. Several can be eligible at once; the first claim wins. */
const [active, setActive] = createSignal<{ owner: symbol; id: FeatureHintId } | null>(null);
const [coolingDown, setCoolingDown] = createSignal(false);
let cooldownTimer: ReturnType<typeof setTimeout> | undefined;

function isFeatureHintSeen(id: FeatureHintId): boolean {
  return store.seenFeatureHints.includes(id);
}

function startCooldown(): void {
  setCoolingDown(true);
  if (cooldownTimer !== undefined) clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    cooldownTimer = undefined;
    setCoolingDown(false);
  }, COOLDOWN_MS);
}

/** Whether a tip wants to show; it still has to win `claimFeatureHint`. */
export function featureHintWanted(id: FeatureHintId): boolean {
  return store.featureHintsEnabled && !isFeatureHintSeen(id);
}

/** Takes the single tip slot for `owner`. Reactive: a waiting tip retries when the slot frees. */
export function claimFeatureHint(owner: symbol, id: FeatureHintId): boolean {
  const current = active();
  if (current?.owner === owner) return true;
  if (current || coolingDown()) return false;
  setActive({ owner, id });
  return true;
}

export function releaseFeatureHint(owner: symbol): void {
  if (active()?.owner === owner) setActive(null);
}

export function isFeatureHintActive(owner: symbol): boolean {
  return active()?.owner === owner;
}

/** The tip on screen, if any, so its feature's own help can stay out of its way. */
export function activeFeatureHint(): FeatureHintId | null {
  return active()?.id ?? null;
}

/** Records that the user saw or used a feature, so its tip does not show again. */
export function markFeatureHintSeen(id: FeatureHintId): void {
  if (isFeatureHintSeen(id)) return;
  // One batch: a waiting tip must see the cooldown before it sees the free slot.
  batch(() => {
    if (active()?.id === id) {
      startCooldown();
      setActive(null);
    }
    setStore('seenFeatureHints', (seen) => [...seen, id]);
  });
  // Persist at once: autosave might not run before the app closes.
  void saveState();
}

/** Turning tips back on shows every tip again. */
export function setFeatureHintsEnabled(enabled: boolean): void {
  setStore('featureHintsEnabled', enabled);
  if (enabled) setStore('seenFeatureHints', []);
}
