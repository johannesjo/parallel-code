import { afterEach, describe, expect, it } from 'vitest';
import {
  createProgramStatusRecords,
  createProgramStatusReporter,
  parseProgramStatus,
  type ProgramStatusReport,
} from './program-status.js';
import {
  getAgentActivityEvidence,
  registerAgentLaunch,
  retireAgentLaunch,
} from './observations.js';

// Literal payloads; the base64 values come from the spec's own examples.
describe('parseProgramStatus', () => {
  it('reads the spec example of a blocked permission request', () => {
    expect(
      parseProgramStatus(
        'state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/',
      ),
    ).toEqual({
      state: 'blocked',
      id: '',
      kind: 'permission',
      msg: 'Apply 3 to add, 1 to change, 0 to destroy?',
    });
  });

  it('recognises the feature query', () => {
    expect(parseProgramStatus('?')).toBe('query');
  });

  it('ignores a report with no state or an unknown one', () => {
    expect(parseProgramStatus('msg=SGk=')).toBeNull();
    expect(parseProgramStatus('state=sleeping')).toBeNull();
  });

  it('skips malformed pairs, trims whitespace and lets a repeated key win last', () => {
    expect(parseProgramStatus(' state = idle :junk:=x:state=done:Bad=1')).toEqual({
      state: 'done',
      id: '',
    });
  });

  it('keeps kind only on blocked and drops unknown kinds', () => {
    expect(parseProgramStatus('state=working:kind=permission')).toEqual({
      state: 'working',
      id: '',
    });
    expect(parseProgramStatus('state=blocked:kind=coffee')).toEqual({ state: 'blocked', id: '' });
  });

  it('accepts unpadded base64 and strips direction overrides from text', () => {
    // "Hi" is SGk= ; U+202E RIGHT-TO-LEFT OVERRIDE + "x" is 4oCueA==
    expect(parseProgramStatus('state=done:msg=SGk')).toMatchObject({ msg: 'Hi' });
    expect(parseProgramStatus('state=done:msg=4oCueA')).toMatchObject({ msg: 'x' });
  });

  it('discards the whole report for bad text, ids or limits', () => {
    // "a\nb" is YQpi: control characters are forbidden in msg and title.
    expect(parseProgramStatus('state=done:msg=YQpi')).toBeNull();
    expect(parseProgramStatus('state=done:title=YQpi')).toBeNull();
    expect(parseProgramStatus('state=done:msg=S')).toBeNull();
    // 0xFF alone is not UTF-8.
    expect(parseProgramStatus('state=done:msg=/w==')).toBeNull();
    expect(parseProgramStatus('state=done:id=a//b')).toBeNull();
    expect(parseProgramStatus(`state=done:id=${'a/'.repeat(8)}a`)).toBeNull();
    expect(parseProgramStatus(`state=done:${'k'.repeat(17)}=1`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${'A'.repeat(2736)}`)).toBeNull();
    expect(parseProgramStatus(`state=done:x=${'a'.repeat(4100)}`)).toBeNull();
    // 2100 two-byte characters: under 4096 characters, but 4200+ bytes.
    expect(parseProgramStatus(`state=done:${'é'.repeat(2100)}`)).toBeNull();
  });
});

function report(state: ProgramStatusReport['state'], extra: Partial<ProgramStatusReport> = {}) {
  return { state, id: '', ...extra } as ProgramStatusReport;
}

describe('createProgramStatusRecords', () => {
  it('tells an approval from a question from an idle prompt', () => {
    const records = createProgramStatusRecords();
    expect(records.apply(report('blocked', { kind: 'permission', msg: 'Run rm?' }))).toEqual({
      state: 'waiting',
      event: 'ProgramStatus',
      prompt: 'permission',
      detail: 'Run rm?',
    });
    expect(records.apply(report('blocked', { kind: 'question' }))).toEqual({
      state: 'waiting',
      event: 'ProgramStatus',
      prompt: 'question',
    });
    expect(records.apply(report('blocked', { kind: 'auth' }))).toEqual({
      state: 'waiting',
      event: 'ProgramStatus',
    });
    expect(records.apply(report('idle'))).toEqual({ state: 'done', event: 'ProgramStatus' });
  });

  it('reports a finished turn as Stop and a failed one as StopFailure', () => {
    const records = createProgramStatusRecords();
    expect(records.apply(report('done'))).toEqual({ state: 'done', event: 'Stop' });
    expect(records.apply(report('error', { msg: 'quota' }))).toEqual({
      state: 'done',
      event: 'StopFailure',
      detail: 'quota',
    });
  });

  it('keeps a finished lead working while a background worker still runs', () => {
    const records = createProgramStatusRecords();
    records.apply(report('working'));
    records.apply(report('working', { id: 'sub-1' }));
    expect(records.apply(report('done'))).toEqual({
      state: 'working',
      event: 'ProgramStatus',
      background: true,
    });
    expect(records.apply(report('done', { id: 'sub-1' }))).toEqual({
      state: 'done',
      event: 'Stop',
    });
  });

  it('lets a blocked worker outrank a working lead', () => {
    const records = createProgramStatusRecords();
    records.apply(report('working'));
    expect(records.apply(report('blocked', { id: 'w', kind: 'question' }))).toMatchObject({
      state: 'waiting',
      prompt: 'question',
    });
  });

  it('clears a record with its children, and everything without an id', () => {
    const records = createProgramStatusRecords();
    records.apply(report('idle'));
    records.apply(report('working', { id: 'build' }));
    records.apply(report('blocked', { id: 'build/test' }));
    expect(records.apply(report('clear', { id: 'build' }))).toEqual({
      state: 'done',
      event: 'ProgramStatus',
    });
    records.apply(report('working'));
    expect(records.apply(report('clear'))).toEqual({ state: 'done', event: 'ProgramStatus' });
  });

  it('reports nothing for a clear that removes nothing', () => {
    const records = createProgramStatusRecords();
    // A full reset from a program that never reported must not claim it is ready.
    expect(records.apply(report('clear'))).toBeNull();
    records.apply(report('working', { id: 'a' }));
    expect(records.apply(report('clear', { id: 'b' }))).toBeNull();
  });

  it('drops the least recently updated record past 64', () => {
    const records = createProgramStatusRecords();
    records.apply(report('working', { id: 'old' }));
    for (let i = 0; i < 64; i++) records.apply(report('idle', { id: `r${i}` }));
    // `old` was evicted, so nothing is working any more.
    expect(records.apply(report('idle', { id: 'r0' }))).toEqual({
      state: 'done',
      event: 'ProgramStatus',
    });
  });
});

describe('a recorded Claude Code 2.1.328 session', () => {
  it('reads every turn boundary, approval and question it reports', () => {
    const records = createProgramStatusRecords();
    const read = (payload: string) => {
      const parsed = parseProgramStatus(payload);
      if (!parsed || parsed === 'query') throw new Error(`unreadable: ${payload}`);
      return records.apply(parsed);
    };
    expect(read('state=idle:app=claude-code')).toEqual({ state: 'done', event: 'ProgramStatus' });
    expect(read('state=working:app=claude-code')).toMatchObject({ state: 'working' });
    expect(read('state=done:app=claude-code')).toMatchObject({ state: 'done', event: 'Stop' });
    expect(
      read(
        'state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBCYXNoOiB0b3VjaCBvc2MtcHJvYmUtbWFya2VyLnR4dCAmJiBscyAtbCBvc2MtcHJvYmUtbWFya2VyLnR4dA==',
      ),
    ).toMatchObject({
      state: 'waiting',
      prompt: 'permission',
      detail: 'approve Bash: touch osc-probe-marker.txt && ls -l osc-probe-marker.txt',
    });
    // Esc at the dialog.
    expect(read('state=idle:app=claude-code')).toMatchObject({ state: 'done' });
    expect(
      read(
        'state=blocked:app=claude-code:kind=question:msg=YW5zd2VyOiBEbyB5b3UgcHJlZmVyIHRlYSBvciBjb2ZmZWU/IChUZWEgwrcgQ29mZmVlKQ==',
      ),
    ).toMatchObject({
      state: 'waiting',
      prompt: 'question',
      detail: 'answer: Do you prefer tea or coffee? (Tea · Coffee)',
    });
  });
});

describe('createProgramStatusReporter', () => {
  const agentId = 'agent-program-status';
  const taskId = 'task-program-status';
  afterEach(() => retireAgentLaunch(agentId, 'launch-2'));

  it('reports through the hook pipeline and drops reports from an exited launch', () => {
    registerAgentLaunch(agentId, taskId, 'launch-1');
    const first = createProgramStatusReporter({ agentId, taskId, launchId: 'launch-1' });
    first(report('blocked', { kind: 'permission' }));
    expect(getAgentActivityEvidence(agentId)).toMatchObject({
      activity: 'waiting',
      prompt: 'permission',
    });

    // The process exited without a final report: its blocked state goes with it.
    retireAgentLaunch(agentId, 'launch-1');
    expect(getAgentActivityEvidence(agentId)).toBeUndefined();

    registerAgentLaunch(agentId, taskId, 'launch-2');
    first(report('working'));
    expect(getAgentActivityEvidence(agentId)).toMatchObject({ activity: 'unknown' });
  });
});
