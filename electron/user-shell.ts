import fs from 'fs';
import * as os from 'os';

interface ResolveUserShellDeps {
  userInfo?: () => { shell: string | null | undefined };
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  canUseShell?: (shell: string) => boolean;
}

function normalizeShell(shell: string | null | undefined): string | null {
  const value = shell?.trim();
  return value ? value : null;
}

function isExecutablePosixShell(shell: string): boolean {
  try {
    fs.accessSync(shell, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveUserShell(deps: ResolveUserShellDeps = {}): string {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const userInfo = deps.userInfo ?? os.userInfo;
  const canUseShell =
    deps.canUseShell ?? ((shell: string) => platform === 'win32' || isExecutablePosixShell(shell));

  if (platform === 'win32') {
    const windowsShell = normalizeShell(env.ComSpec);
    const powerShell = normalizeShell(env.PSModulePath) ? 'powershell.exe' : null;
    for (const shell of [windowsShell, powerShell, 'cmd.exe']) {
      if (shell && canUseShell(shell)) return shell;
    }
    return 'cmd.exe';
  }

  try {
    const osShell = normalizeShell(userInfo().shell);
    if (osShell && canUseShell(osShell)) return osShell;
  } catch {
    // Fall back to inherited environment if the OS lookup is unavailable.
  }

  const envShell = normalizeShell(env.SHELL);
  if (envShell && canUseShell(envShell)) return envShell;

  return '/bin/sh';
}
