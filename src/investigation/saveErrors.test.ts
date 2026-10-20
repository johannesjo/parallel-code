import { expect, it } from 'vitest';
import { conflictMessage, describeSaveFailure } from './saveErrors';

it('recognises revision conflicts and strips the Electron IPC prefix', () => {
  expect(
    describeSaveFailure(
      new Error(
        "Error invoking remote method 'reasoning:commit': The graph revision or run changed. Use reasoning_read and retry.",
      ),
      'Could not save node.',
    ),
  ).toEqual({ conflict: true, message: conflictMessage });
  expect(
    describeSaveFailure(new Error('The graph has changed. Read it again.'), 'x'),
  ).toMatchObject({ conflict: true });
  expect(
    describeSaveFailure(
      new Error("Error invoking remote method 'x': Disk full"),
      'Could not save.',
    ),
  ).toEqual({ conflict: false, message: 'Disk full' });
  expect(describeSaveFailure(new Error('Supply expectedRevision.'), 'x')).toEqual({
    conflict: false,
    message: 'Supply expectedRevision.',
  });
  expect(describeSaveFailure('boom', 'Could not save node.')).toEqual({
    conflict: false,
    message: 'Could not save node.',
  });
});
