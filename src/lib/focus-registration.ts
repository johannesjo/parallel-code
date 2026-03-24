import { onCleanup } from 'solid-js';
import { registerFocusFn, unregisterFocusFn } from '../store/store';

/**
 * Register a focus function that auto-unregisters on cleanup.
 * Works in both onMount and createEffect scopes.
 */
export function useFocusRegistration(key: string, fn: () => void): void {
  registerFocusFn(key, fn);
  onCleanup(() => unregisterFocusFn(key));
}
