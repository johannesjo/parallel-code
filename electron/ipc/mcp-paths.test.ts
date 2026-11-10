import { describe, expect, it } from 'vitest';
import { unpackedAsarPath } from './mcp-paths.js';

describe('unpackedAsarPath', () => {
  it('points a Windows archive path at the unpacked copy', () => {
    expect(
      unpackedAsarPath(
        'C:\\Program Files\\Parallel Code\\resources\\app.asar\\dist-electron\\mcp-server.cjs',
      ),
    ).toBe(
      'C:\\Program Files\\Parallel Code\\resources\\app.asar.unpacked\\dist-electron\\mcp-server.cjs',
    );
  });

  it('points a POSIX archive path at the unpacked copy', () => {
    expect(
      unpackedAsarPath(
        '/Applications/Parallel Code.app/Contents/Resources/app.asar/dist-electron/mcp-server.cjs',
      ),
    ).toBe(
      '/Applications/Parallel Code.app/Contents/Resources/app.asar.unpacked/dist-electron/mcp-server.cjs',
    );
  });

  it('leaves development paths alone', () => {
    expect(unpackedAsarPath('/home/dev/parallel-code/dist-electron/mcp-server.cjs')).toBe(
      '/home/dev/parallel-code/dist-electron/mcp-server.cjs',
    );
  });
});
