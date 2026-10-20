import { error } from 'node:console';
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated renderer sandbox: no agent processes, preload, or application data.
const userData = mkdtempSync(join(tmpdir(), 'parallel-code-investigation-'));
app.setPath('userData', userData);
app.on('will-quit', () => rmSync(userData, { recursive: true, force: true }));
app.on('window-all-closed', () => app.quit());
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      width: 1440,
      height: 960,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await window.loadURL('http://localhost:1422/investigation.html');
  })
  .catch((cause) => {
    error(cause);
    app.exit(1);
  });
