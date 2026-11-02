import { execFileSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { errMessage, warn as logWarn } from '../log.js';

/**
 * Environment variable that marks every process a capture run starts. It is
 * inherited through `setsid`, `nohup` and double forks, which escape a process
 * group; only a process started with a cleared environment loses it.
 */
export const RUN_TAG_ENV = 'PC_SCREENS_RUN';

function taggedOnLinux(entry: string): number[] {
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const env = readFileSync(`/proc/${name}/environ`, 'latin1');
      if (env.split('\0').includes(entry)) pids.push(Number(name));
    } catch {
      // Exited meanwhile, or another user's process: neither is ours to stop.
      continue;
    }
  }
  return pids;
}

function taggedOnMac(entry: string): number[] {
  // `-e` appends each process's environment to its command line.
  const out = execFileSync('ps', ['-axeww', '-o', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.split(' ').includes(entry))
    .map((line) => Number.parseInt(line, 10));
}

/** Processes whose environment carries the run's tag. */
export function findTagged(tag: string): number[] {
  const entry = `${RUN_TAG_ENV}=${tag}`;
  const pids = process.platform === 'linux' ? taggedOnLinux(entry) : taggedOnMac(entry);
  return pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/** Sends the signal to every process carrying the tag. */
export function signalTagged(tag: string, signal: NodeJS.Signals): void {
  let pids: number[];
  try {
    pids = findTagged(tag);
  } catch (error) {
    logWarn('taskScreens', 'Could not list the processes of a capture', {
      error: errMessage(error),
    });
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // ESRCH: it exited between the scan and the signal.
      continue;
    }
  }
}
