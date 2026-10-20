import { describe, expect, it } from 'vitest';
import { readSingleJsonObject } from './tour-json';

const object = { gist: { title: 'Gist' }, cards: [{ title: 'One' }] };
const json = JSON.stringify(object);

describe('readSingleJsonObject', () => {
  it('reads a bare JSON object', () => {
    expect(readSingleJsonObject(json)).toEqual(object);
  });

  it.each([
    ['```json\n', '\n```'],
    ['```\n', '\n```'],
    ['Here it is:\n```json\n', '\n```\nSee [the code](file.ts).'],
  ])('strips code fences and surrounding commentary (%s)', (prefix, suffix) => {
    expect(readSingleJsonObject(prefix + json + suffix)).toEqual(object);
  });

  it('ignores trailing commentary that contains brackets and braces', () => {
    expect(readSingleJsonObject(`${json}\nNote: use {curly} braces and [links](a.ts).`)).toEqual(
      object,
    );
  });

  it('ignores braces and escaped quotes inside JSON strings', () => {
    const tricky = { cards: [{ body: 'Handles { "nested": ["x"] } and \\ escapes.' }] };
    expect(readSingleJsonObject(`Tour:\n${JSON.stringify(tricky)}\nDone.`)).toEqual(tricky);
  });

  it('rejects two complete objects instead of picking the first', () => {
    expect(() => readSingleJsonObject(`${json}\n${json}`)).toThrow(/single complete tour/i);
  });

  it('rejects a response with no JSON object at all', () => {
    expect(() => readSingleJsonObject('I cannot do that.')).toThrow(/single complete tour/i);
  });

  it('rejects a truncated object', () => {
    expect(() => readSingleJsonObject('{"cards":[{"title":"One"}')).toThrow(/incomplete/i);
    expect(() => readSingleJsonObject(`${json}\n{"cards":[`)).toThrow(/incomplete/i);
  });

  it('rejects malformed JSON instead of repairing it', () => {
    expect(() => readSingleJsonObject('{"cards":[{"title":"One"},]}\nDone.')).toThrow(/malformed/i);
  });

  it('ignores an unrelated complete object when a required key is given', () => {
    const noisy = `Usage: {"model":"minimax","tokens":10}\n${json}\nDone.`;
    expect(() => readSingleJsonObject(noisy)).toThrow(/single complete tour/i);
    expect(readSingleJsonObject(noisy, 'gist')).toEqual(object);
  });

  it('only treats a cut-off object carrying the required key as incomplete', () => {
    expect(() => readSingleJsonObject('Here: {"gist":{"title":"One"}', 'gist')).toThrow(
      /incomplete/i,
    );
    expect(readSingleJsonObject(`${json}\nNote: {"unrelated": "x"`, 'gist')).toEqual(object);
  });
});
