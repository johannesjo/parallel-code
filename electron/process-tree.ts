import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';

/** Windows has no POSIX process groups. taskkill /T terminates descendants of
 * a shell or CLI as well as the parent, without involving cmd interpolation. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 }, (err) => {
      if (err) {
        try { child.kill(); } catch { /* already gone */ }
      }
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}
