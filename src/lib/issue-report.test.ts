import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIssueUrl, describeRuntime } from './issue-report';

const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) parallel-code/5.1.0 Chrome/140.0.0.0 Electron/38.2.1 Safari/537.36';

describe('describeRuntime', () => {
  it('names the platform and Electron version', () => {
    expect(describeRuntime(LINUX_UA)).toBe('Linux · Electron 38.2.1');
  });

  // Chromium freezes the macOS version in the user agent, so it must not be reported.
  it('reports macOS without the frozen version number', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Electron/38.2.1 Safari/537.36';
    expect(describeRuntime(ua)).toBe('macOS · Electron 38.2.1');
  });

  it('reports Windows', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Electron/38.2.1 Safari/537.36';
    expect(describeRuntime(ua)).toBe('Windows · Electron 38.2.1');
  });

  it('returns nothing for an unrecognised user agent', () => {
    expect(describeRuntime('custom-agent')).toBe('');
  });
});

describe('buildIssueUrl', () => {
  it('pre-fills the bug form fields by id', () => {
    const url = new URL(
      buildIssueUrl('bug', {
        version: '5.1.0',
        runtime: 'X11; Linux x86_64 · Electron 38.2.1',
        agents: ['Claude Code', 'Codex CLI'],
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://github.com/johannesjo/parallel-code/issues/new',
    );
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('version')).toBe('5.1.0');
    expect(url.searchParams.get('os')).toBe('X11; Linux x86_64 · Electron 38.2.1');
    expect(url.searchParams.get('agents')).toBe('Claude Code, Codex CLI');
  });

  it('leaves out empty diagnostics instead of sending blank fields', () => {
    const url = new URL(buildIssueUrl('bug', { version: '', runtime: 'x', agents: [] }));
    expect(url.searchParams.has('version')).toBe(false);
    expect(url.searchParams.has('agents')).toBe(false);
  });

  it('opens the feature form without diagnostics', () => {
    const url = new URL(
      buildIssueUrl('feature', { version: '5.1.0', runtime: 'x', agents: ['Claude Code'] }),
    );
    expect([...url.searchParams.keys()]).toEqual(['template']);
    expect(url.searchParams.get('template')).toBe('feature_request.yml');
  });
});

// The app links to these forms by file name and field id; renaming either on
// GitHub silently drops the pre-filled values.
describe('issue form templates', () => {
  const template = (name: string) =>
    readFileSync(new URL(`../../.github/ISSUE_TEMPLATE/${name}`, import.meta.url), 'utf8');

  it('has the fields the bug report pre-fills', () => {
    const ids = [...template('bug_report.yml').matchAll(/^\s+id: (\S+)$/gm)].map((m) => m[1]);
    expect(ids).toEqual(expect.arrayContaining(['version', 'os', 'agents']));
  });

  it('has the feature form', () => {
    expect(template('feature_request.yml')).toContain('name: Feature idea');
  });
});
