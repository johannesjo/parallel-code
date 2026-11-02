import { BrowserWindow, session, type Event, type Session } from 'electron';

/** Both versions are shown at this size, so their screenshots line up. */
export const VIEWPORT = { width: 1280, height: 800 };
/** A page still loading a resource after this is shot as far as it rendered. */
const LOAD_TIMEOUT_MS = 20_000;
/** Client-side apps render after the load event; this gives them time to settle. */
const SETTLE_MS = 1_500;

/** Only servers on this machine: the model's answer cannot point the app elsewhere. */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname)
  );
}

let screensSession: Session | undefined;

/** One in-memory session for every capture; page content is untrusted. */
function getSession(): Session {
  if (screensSession) return screensSession;
  screensSession = session.fromPartition('pc-screens');
  screensSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  screensSession.setPermissionCheckHandler(() => false);
  screensSession.on('will-download', (event) => event.preventDefault());
  return screensSession;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function openWindow(ses: Session): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    ...VIEWPORT,
    webPreferences: {
      session: ses,
      // Paints without ever showing a window on the user's screen.
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const stayLocal = (event: Event, url: string) => {
    if (!isLoopbackUrl(url)) event.preventDefault();
  };
  wc.on('will-navigate', stayLocal);
  wc.on('will-redirect', stayLocal);
  return win;
}

/** Loads a page of the app in a hidden window and returns how it looks, as PNG. */
export async function shootPage(url: string): Promise<Buffer> {
  if (!isLoopbackUrl(url)) throw new Error(`Not a local address: ${url}`);
  const ses = getSession();
  // Before and after share a host, and cookies ignore the port.
  // shortcut: one session, so two tasks capturing at once clear each other's storage — a partition per run if that matters.
  await ses.clearStorageData();
  const win = openWindow(ses);
  try {
    await Promise.race([win.loadURL(url), delay(LOAD_TIMEOUT_MS)]);
    await delay(SETTLE_MS);
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error(`Nothing rendered at ${url}`);
    return image.toPNG();
  } finally {
    win.destroy();
  }
}
