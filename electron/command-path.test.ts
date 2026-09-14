import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as pty from 'node-pty';
import { resolveCommand, windowsPtyCommand } from './command-path.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('Windows command resolution', () => {
  it('finds npm shims and native CLIs through PATHEXT, including spaced paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel commands '));
    dirs.push(dir);
    for (const name of ['claude.cmd', 'codex.exe', 'agy.exe']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    const env = { Path: dir, PATHEXT: '.EXE;.CMD' };
    expect(resolveCommand('claude', 'win32', env)).toBe(path.join(dir, 'claude.cmd'));
    expect(resolveCommand('codex', 'win32', env)).toBe(path.join(dir, 'codex.exe'));
    expect(resolveCommand('agy', 'win32', env)).toBe(path.join(dir, 'agy.exe'));
    expect(resolveCommand(path.join(dir, 'claude.cmd'), 'win32', env)).toBe(
      path.join(dir, 'claude.cmd'),
    );
    expect(() => resolveCommand('missing', 'win32', env)).toThrow(/not found/);
  });

  it('starts .cmd shims through cmd.exe and leaves native executables alone', () => {
    const wrapped = windowsPtyCommand('C:\\Program Files\\Agent\\claude.cmd', ['hello world']);
    expect(wrapped.command.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(wrapped.args).toEqual([
      '/d', '/s', '/c', 'C:\\Program Files\\Agent\\claude.cmd', 'hello world',
    ]);
    expect(windowsPtyCommand('C:\\tools\\agy.exe', ['x'])).toEqual({
      command: 'C:\\tools\\agy.exe', args: ['x'],
    });
  });

  it('runs a .cmd shim in ConPTY with a spaced path and argument', async () => {
    const baseDir = process.env.SystemDrive ? path.join(process.env.SystemDrive + '\\', 'Temp') : os.tmpdir();
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(baseDir, 'par-pty-'));
    dirs.push(dir);
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\necho READY:%~1\r\n');
    const launch = windowsPtyCommand(shim, ['hello world']);
    const sanitizedEnv = { ...process.env };
    for (const key of Object.keys(sanitizedEnv)) {
      if (typeof sanitizedEnv[key] === 'string' && (sanitizedEnv[key]!.startsWith('\\\\') || sanitizedEnv[key]!.includes('Meu Drive'))) {
        delete sanitizedEnv[key];
      }
    }
    const output = await new Promise<string>((resolve, reject) => {
      const proc = pty.spawn(launch.command, launch.args, {
        cwd: dir,
        env: sanitizedEnv as Record<string, string>,
        cols: 80,
        rows: 24,
        useConpty: true,
      });
      let text = '';
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(`ConPTY timed out: ${text}`));
      }, 5000);
      proc.onData((data) => { text += data; });
      proc.onExit(() => { clearTimeout(timeout); resolve(text); });
    });
    expect(output).toContain('READY:hello world');
  });
  it('handles complex prompts with special characters (&, %, ^, quotes, accents, spaces)', async () => {
    const baseDir = process.env.SystemDrive ? path.join(process.env.SystemDrive + '\\', 'Temp') : os.tmpdir();
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(baseDir, 'par-pty-spec-'));
    dirs.push(dir);
    const shim = path.join(dir, 'test-prompt.cmd');
    const outFile = path.join(dir, 'received.txt');
    fs.writeFileSync(shim, `@echo off\r\necho %* > "${outFile}"\r\necho PROMPT:%*\r\n`);
    const complexArg = 'Fix "bug" & test %PATH% ^ (ç ã é) "spaced path"';
    const launch = windowsPtyCommand(shim, [complexArg]);
    const sanitizedEnv = { ...process.env };
    for (const key of Object.keys(sanitizedEnv)) {
      if (typeof sanitizedEnv[key] === 'string' && (sanitizedEnv[key]!.startsWith('\\\\') || sanitizedEnv[key]!.includes('Meu Drive'))) {
        delete sanitizedEnv[key];
      }
    }
    await new Promise<string>((resolve, reject) => {
      const proc = pty.spawn(launch.command, launch.args, {
        cwd: dir,
        env: sanitizedEnv as Record<string, string>,
        cols: 80,
        rows: 24,
        useConpty: true,
      });
      let text = '';
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(`ConPTY timed out: ${text}`));
      }, 5000);
      proc.onData((data) => { text += data; });
      proc.onExit(() => { clearTimeout(timeout); resolve(text); });
    });
    expect(fs.existsSync(outFile)).toBe(true);
    const receivedContent = fs.readFileSync(outFile, 'utf8');
    expect(receivedContent).toContain('Fix');
    expect(receivedContent).toContain('bug');
    expect(receivedContent).toContain('spaced path');
  });
});
