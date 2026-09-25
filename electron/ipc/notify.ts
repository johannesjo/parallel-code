/**
 * Sends a message to the desktop UI.
 *
 * Runtime modules (PTY, git, plan and step watchers, the coordinator) take this
 * instead of a `BrowserWindow`, so they do not depend on Electron and can run
 * without a window. The desktop shell supplies one with `windowNotifier`.
 */
export type Notify = (channel: string, payload: unknown) => void;
