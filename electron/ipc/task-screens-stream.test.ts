import { describe, expect, it } from 'vitest';
import { createScreensStream, describeStep } from './task-screens-stream.js';

const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const toolCall = (name: string, input: unknown) =>
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

describe('describeStep', () => {
  it("uses Claude's description of a shell command, never the command itself", () => {
    expect(describeStep('Bash', { command: 'npm i', description: 'Install dependencies' })).toBe(
      'Install dependencies',
    );
    expect(describeStep('Bash', { command: 'API_KEY=secret npm run dev' })).toBe(
      'Running a command',
    );
    expect(describeStep('Bash', { description: 'x'.repeat(200) })).toHaveLength(80);
  });

  it('names reading tools as reading the code', () => {
    expect(describeStep('Grep', { pattern: 'Login' })).toBe('Reading the code');
    expect(describeStep('Read', { file_path: '/out/after.png' })).toBe('Checking a screenshot');
  });
});

describe('createScreensStream', () => {
  it('reports steps across chunk boundaries and keeps the final answer', () => {
    const steps: string[] = [];
    const stream = createScreensStream((step) => steps.push(step));
    const text = toolCall('Bash', { command: 'npx playwright screenshot', description: 'Shoot' });
    stream.feed(text.slice(0, 20));
    expect(steps).toEqual([]);
    stream.feed(text.slice(20) + 'stray output\n');
    stream.feed(line({ type: 'result', is_error: false, result: '{"shots":[]}' }));
    expect(steps).toEqual(['Shoot']);
    expect(stream.outcome()).toEqual({ answer: '{"shots":[]}' });
  });

  it('reads a final line without a newline, and an error result', () => {
    const stream = createScreensStream(() => undefined);
    stream.feed(
      JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance too low' }),
    );
    expect(stream.outcome()).toEqual({ error: 'Credit balance too low' });
  });

  it('has no outcome when the run ended without a result', () => {
    const stream = createScreensStream(() => undefined);
    stream.feed(toolCall('Read', { file_path: '/a' }));
    expect(stream.outcome()).toBeUndefined();
  });

  it('names a failure that only has a subtype, or the errors list', () => {
    const stream = createScreensStream(() => undefined);
    stream.feed(line({ type: 'result', is_error: true, subtype: 'error_max_turns' }));
    expect(stream.outcome()).toEqual({ error: 'Claude stopped: max turns.' });
    stream.feed(line({ type: 'result', is_error: true, errors: ['Rate limited'] }));
    expect(stream.outcome()).toEqual({ error: 'Rate limited' });
  });

  it('skips an oversized line whole and still reads the next one', () => {
    const steps: string[] = [];
    const stream = createScreensStream((step) => steps.push(step));
    const huge = `{"type":"user","content":"${'x'.repeat(1_200_000)}"}\n`;
    // Split mid-line, so the rest of the huge line arrives in a later read.
    stream.feed(huge.slice(0, 1_100_000));
    stream.feed(huge.slice(1_100_000) + toolCall('Grep', { pattern: 'a' }));
    stream.feed(line({ type: 'result', is_error: false, result: 'ok' }));
    expect(steps).toEqual(['Reading the code']);
    expect(stream.outcome()).toEqual({ answer: 'ok' });
  });
});
