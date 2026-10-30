import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('install.sh', () => {
  it('uses the full release artifact build sequence for macOS packaging', () => {
    const script = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8');

    expect(script).toContain(
      'npm run build:frontend && npm run build:remote && npm run compile && npm run build:mcp && npx electron-builder --config.mac.identity=null',
    );
  });

  it('builds Linux packages through npm run build so packaging keeps umask 022', () => {
    const script = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8');

    expect(script).toContain('npm run build -- --linux rpm --publish never');
    expect(script).toContain('npm run build -- --linux AppImage deb --publish never');
  });

  it('checks for rpmbuild before building an rpm', () => {
    const script = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8');

    expect(script).toContain('command -v rpmbuild');
    expect(script).toContain('sudo dnf install rpm-build');
  });

  it('documents the Linux-only --no-install option', () => {
    const script = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8');

    expect(script).toContain('--no-install  Build the package without installing it (Linux only).');
    expect(script).toContain('--no-install is only supported on Linux');
  });
});
