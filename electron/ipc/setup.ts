import { spawn } from 'child_process';
import type { BrowserWindow } from 'electron';

export async function runSetupCommands(
  win: BrowserWindow,
  args: { worktreePath: string; projectRoot: string; commands: string[]; channelId: string },
): Promise<void> {
  const { worktreePath, projectRoot, commands, channelId } = args;

  const expandVars = (cmd: string): string =>
    cmd
      .replace(/\$\{PROJECT_ROOT\}|\$PROJECT_ROOT\b/g, () => projectRoot)
      .replace(/\$\{WORKTREE\}|\$WORKTREE\b/g, () => worktreePath);

  const send = (msg: string) => {
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, msg);
    }
  };

  for (const raw of commands) {
    const cmd = expandVars(raw);
    send(`$ ${cmd}\n`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, {
        shell: true,
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (chunk: Buffer) => {
        send(chunk.toString('utf8'));
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        send(chunk.toString('utf8'));
      });

      let settled = false;
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new Error(`Command "${cmd}" exited with code ${code}`));
        } else {
          resolve();
        }
      });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to run "${cmd}": ${err.message}`));
      });
    });
  }
}
