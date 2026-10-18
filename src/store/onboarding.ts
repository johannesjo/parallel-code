import { batch, createSignal } from 'solid-js';
import { store, setStore } from './core';
import { saveState } from './persistence';
import type { FeatureHintId } from '../lib/feature-hints';

/** After a tip is dismissed, the next one waits this long, so tips never chain. */
const COOLDOWN_MS = 60_000;

/** The one tip on screen. Several can be eligible at once; the first claim wins. */
const [activeOwner, setActiveOwner] = createSignal<symbol | null>(null);
const [coolingDown, setCoolingDown] = createSignal(false);
let cooldownTimer: ReturnType<typeof setTimeout> | undefined;

function isFeatureHintSeen(id: FeatureHintId): boolean {
  return store.seenFeatureHints.includes(id);
}

/** Whether a tip wants to show; it still has to win `claimFeatureHint`. */
export function featureHintWanted(id: FeatureHintId): boolean {
  return store.featureHintsEnabled && !isFeatureHintSeen(id);
}

/** Takes the single tip slot for `owner`. Reactive: a waiting tip retries when the slot frees. */
export function claimFeatureHint(owner: symbol): boolean {
  const current = activeOwner();
  if (current === owner) return true;
  if (current !== null || coolingDown()) return false;
  setActiveOwner(owner);
  return true;
}

export function releaseFeatureHint(owner: symbol): void {
  if (activeOwner() === owner) setActiveOwner(null);
}

export function isFeatureHintActive(owner: symbol): boolean {
  return activeOwner() === owner;
}

/** Records that the user saw or used a feature, so its tip does not show again. */
export function markFeatureHintSeen(id: FeatureHintId): void {
  if (isFeatureHintSeen(id)) return;
  setStore('seenFeatureHints', (seen) => [...seen, id]);
  // Persist at once: autosave might not run before the app closes.
  void saveState();
}

export function dismissFeatureHint(id: FeatureHintId, owner: symbol): void {
  // One batch: a waiting tip must see the cooldown before it sees the free slot.
  batch(() => {
    setCoolingDown(true);
    markFeatureHintSeen(id);
    releaseFeatureHint(owner);
  });
  if (cooldownTimer !== undefined) clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    cooldownTimer = undefined;
    setCoolingDown(false);
  }, COOLDOWN_MS);
}

/** Turning tips back on shows every tip again. */
export function setFeatureHintsEnabled(enabled: boolean): void {
  setStore('featureHintsEnabled', enabled);
  if (enabled) setStore('seenFeatureHints', []);
}
