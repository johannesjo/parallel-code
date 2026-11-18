import { describe, expect, it } from 'vitest';
import { parsePromptMenu, samePromptMenu, seenPromptMenu } from './prompt-menu.js';

// Claude Code's permission dialog as the mirror's visible screen shows it.
const CLAUDE_BASH = [
  '⏺ Bash(npm test)',
  '',
  '─'.repeat(60),
  ' Bash command',
  '',
  '   npm run test:unit -- src/store/taskStatus.test.ts',
  '   Run the task status tests',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm test commands in /home/user/project",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

const CODEX_APPROVAL = [
  '• Ran git status',
  '',
  '  Would you like to run the following command?',
  '  $ npm test',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for this command (p)",
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n');

describe('parsePromptMenu', () => {
  it("reads Claude's permission dialog: body, labels, number keys, Esc for the typed decline", () => {
    expect(parsePromptMenu(CLAUDE_BASH)).toEqual({
      body: [
        'Bash command',
        '',
        'npm run test:unit -- src/store/taskStatus.test.ts',
        'Run the task status tests',
        '',
        'Do you want to proceed?',
      ],
      options: [
        { n: 1, label: 'Yes', key: '1', typed: false },
        {
          n: 2,
          label: "Yes, and don't ask again for npm test commands in /home/user/project",
          key: '2',
          typed: false,
        },
        {
          n: 3,
          label: 'No, and tell Claude what to do differently',
          key: '\x1b',
          typed: true,
        },
      ],
    });
  });

  it("uses Codex's letter hints as keys", () => {
    const menu = parsePromptMenu(CODEX_APPROVAL);
    expect(menu?.options.map((o) => [o.label, o.key])).toEqual([
      ['Yes, proceed', 'y'],
      ["Yes, and don't ask again for this command", 'p'],
      ['No, and tell Codex what to do differently', '\x1b'],
    ]);
    expect(menu?.body.slice(-2)).toEqual([
      'Would you like to run the following command?',
      '$ npm test',
    ]);
  });

  it('keeps option descriptions apart from labels, wherever the cursor is', () => {
    const question = [
      '─'.repeat(40),
      ' Should the diff viewer follow the app theme?',
      '',
      '   1. App theme',
      '      Matches the rest of the app',
      ' ❯ 2. Own toggle',
      "      Keeps today's behaviour",
      '   3. Type something.',
      '',
    ].join('\n');
    expect(parsePromptMenu(question)?.options).toEqual([
      { n: 1, label: 'App theme', detail: 'Matches the rest of the app', key: '1', typed: false },
      { n: 2, label: 'Own toggle', detail: "Keeps today's behaviour", key: '2', typed: false },
      { n: 3, label: 'Type something.', key: '3', typed: true },
    ]);
  });

  it('reads a dialog drawn inside a box', () => {
    const boxed = [
      '╭──────────────────────────╮',
      '│ Edit file                │',
      '│ Do you want to proceed?  │',
      '│ ❯ 1. Yes                 │',
      '│   2. No                  │',
      '╰──────────────────────────╯',
    ].join('\n');
    expect(parsePromptMenu(boxed)).toEqual({
      body: ['Edit file', 'Do you want to proceed?'],
      options: [
        { n: 1, label: 'Yes', key: '1', typed: false },
        { n: 2, label: 'No', key: '2', typed: false },
      ],
    });
  });

  it('keeps a letter in brackets as label text unless every choice names its key', () => {
    const question = [' Which layout?', ' ❯ 1. Grid', '   2. Use plan (b)'].join('\n');
    expect(parsePromptMenu(question)?.options.map((o) => [o.label, o.key])).toEqual([
      ['Grid', '1'],
      ['Use plan (b)', '2'],
    ]);
  });

  it("accepts Gemini's radio cursor before a number", () => {
    const gemini = ['Allow execution?', '● 1. Yes, allow once', '  2. No'].join('\n');
    expect(parsePromptMenu(gemini)?.options.map((o) => o.label)).toEqual(['Yes, allow once', 'No']);
  });

  it('is null once the input prompt is back below the choices', () => {
    const answered = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      '⏺ Bash(npm test)',
      '─'.repeat(60),
      '❯ ',
      '─'.repeat(60),
    ].join('\n');
    expect(parsePromptMenu(answered)).toBeNull();
  });

  it('is null for a numbered list without a selection cursor', () => {
    expect(parsePromptMenu('Plan:\n1. Read the code\n2. Fix it\n❯ ')).toBeNull();
  });
});

describe('samePromptMenu', () => {
  it('compares the question and its choices, not where the cursor is', () => {
    const a = parsePromptMenu(CLAUDE_BASH);
    const moved = parsePromptMenu(
      CLAUDE_BASH.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes', ' ❯ 2. Yes'),
    );
    const codex = parsePromptMenu(CODEX_APPROVAL);
    if (!a || !moved || !codex) throw new Error('fixtures must parse');
    const otherCommand = parsePromptMenu(
      CLAUDE_BASH.replace('src/store/taskStatus.test.ts', 'src/store/tasks.test.ts'),
    );
    if (!otherCommand) throw new Error('fixture must parse');
    expect(samePromptMenu(a, seenPromptMenu(moved))).toBe(true);
    expect(samePromptMenu(a, seenPromptMenu(codex))).toBe(false);
    expect(samePromptMenu(a, seenPromptMenu(otherCommand))).toBe(false);
  });
});
