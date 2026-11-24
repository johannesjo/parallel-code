/**
 * The Add card gallery: AI presets, the app facts not shown yet, and sample
 * values for the editor's preview. Presets are definitions with a filled-in
 * description, so a preset and a described card end in the same editor.
 */

import { appFactCard } from './app-facts';
import type { SlotDefinition, SlotValue } from './card-slots';
import { APP_FACTS, freeCardId, type CardDefinition } from './cards';

export type CardPreset = Omit<CardDefinition, 'id' | 'enabled'>;

/** The Bottom line preset's id; the Finish dialog shows that card first, above the merge options. */
export const BOTTOM_LINE_CARD_ID = 'bottom-line';

const READS_ALL = ['task-name', 'prompts', 'agent-message', 'diff'] as const;

export const AI_PRESETS: readonly CardPreset[] = [
  {
    name: 'Plan progress',
    description: 'Steps of the plan, which is done, which is next',
    source: {
      kind: 'model',
      model: 'default',
      prompt: "List the steps of the task's plan and mark each done, current or todo.",
      inputs: [...READS_ALL],
      trigger: 'after-turn',
    },
    slots: [{ id: 'steps', type: 'checklist', label: 'Steps' }],
  },
  {
    name: 'Review first',
    description: 'What to look at before merging, with files',
    source: {
      kind: 'model',
      model: 'default',
      prompt: 'Name what a reviewer should look at first in this change, with the file for each.',
      inputs: ['diff'],
      trigger: 'after-turn',
    },
    slots: [{ id: 'look', type: 'items', label: 'Look at', hint: 'Mark risky spots warn.' }],
  },
  {
    name: 'Decisions',
    description: 'Choices the agent made, adds up across turns',
    source: {
      kind: 'model',
      model: 'default',
      prompt: 'List design choices the agent made this turn, one short sentence each.',
      inputs: ['prompts', 'agent-message', 'diff'],
      trigger: 'after-turn',
    },
    slots: [{ id: 'decisions', type: 'items', label: 'Decisions', addUp: true }],
  },
  {
    name: 'Release note',
    description: 'One user-facing sentence, with Copy',
    source: {
      kind: 'model',
      model: 'default',
      prompt: 'Write one release-note sentence a user of the product would understand.',
      inputs: [...READS_ALL],
      trigger: 'finish',
    },
    slots: [{ id: 'note', type: 'text', label: 'Release note' }],
    showAtFinish: true,
  },
  {
    name: 'Done criteria',
    description: 'A checklist the agent fills via card_publish',
    source: { kind: 'agent' },
    slots: [{ id: 'criteria', type: 'checklist', label: 'Criteria' }],
  },
  {
    name: 'Bottom line',
    description:
      'What I need to know to finish or continue this task, in plain words about the result, not the code. The agent fills it via card_publish when it finishes a piece of work.',
    source: { kind: 'agent' },
    showAtFinish: true,
    hideEmpty: true,
    slots: [
      {
        id: 'verdict',
        type: 'line',
        label: 'Verdict',
        hint: 'One short sentence: "Ready to merge." or "Not ready:" and why. Then what the work achieves.',
      },
      {
        id: 'needs',
        type: 'items',
        label: 'Needs you',
        hint: 'Only questions or actions the user must handle before finishing; severity block. Leave empty if none.',
      },
      {
        id: 'changed',
        type: 'line',
        label: 'What changed',
        hint: 'What users will notice, not files or functions.',
      },
      {
        id: 'decided',
        type: 'items',
        label: 'Decided for you',
        hint: 'Choices you made that the user might want differently, and how easy each is to change.',
      },
      {
        id: 'unchecked',
        type: 'items',
        label: 'Not checked',
        hint: 'What was not verified, e.g. not tried in the running app, only unit tests ran.',
      },
      {
        id: 'open',
        type: 'items',
        label: 'Open',
        hint: 'Loose ends and follow-ups that are not part of this task.',
      },
    ],
  },
];

/** A preset as a new card, under an id not in `taken`. */
export function presetCard(preset: CardPreset, taken: ReadonlySet<string>): CardDefinition {
  return { ...structuredClone(preset), id: freeCardId(preset.name, taken), enabled: true };
}

/** App-fact cards for the facts no card shows yet. */
export function missingFactCards(cards: readonly CardDefinition[]): CardDefinition[] {
  const shown = new Set(
    cards.flatMap((card) => (card.source.kind === 'app' ? [card.source.fact] : [])),
  );
  return APP_FACTS.filter((fact) => !shown.has(fact)).map((fact) => appFactCard(fact, true));
}

/** A made-up value of the slot's type, so the editor shows the layout filled. */
export function sampleValue(slot: SlotDefinition): SlotValue {
  switch (slot.type) {
    case 'line':
      return { type: 'line', text: 'Retries now back off before the third attempt.' };
    case 'text':
      return { type: 'text', text: 'Login retries back off instead of failing at once.' };
    case 'score':
      return { type: 'score', score: 78, why: 'Covered by tests; docs not updated.' };
    case 'scores':
      return {
        type: 'scores',
        scores: [
          { label: 'Correct', score: 86, why: 'Read every caller; one path untested.' },
          { label: 'Complete', score: 54, why: 'Retry limit is not configurable yet.' },
          { label: 'Minimal', score: 91, why: 'One unrelated rename.' },
        ],
      };
    case 'stat':
      return { type: 'stat', value: 6, unit: '' };
    case 'items':
      return {
        type: 'items',
        items: [
          { text: 'Timeout is not configurable', severity: 'warn', file: 'src/retry.ts' },
          { text: 'Old helper left unused', severity: 'info' },
        ],
      };
    case 'checklist':
      return {
        type: 'checklist',
        items: [
          { text: 'Add backoff', state: 'done' },
          { text: 'Test the retry limit', state: 'current' },
          { text: 'Update the docs', state: 'todo' },
        ],
      };
    case 'status':
      return {
        type: 'status',
        rows: [
          { state: 'ok', text: 'Unit tests', value: '41 s' },
          { state: 'warn', text: 'Lint', value: '2 warnings' },
        ],
      };
  }
}

/** A sample value as a check writes it: lists and lines bare, the rest without the type tag. */
function rawSample(value: SlotValue): unknown {
  switch (value.type) {
    case 'line':
    case 'text':
      return value.text;
    case 'items':
    case 'checklist':
      return value.items;
    case 'status':
      return value.rows;
    case 'scores':
      return value.scores;
    default: {
      const { type: _type, ...rest } = value;
      return rest;
    }
  }
}

/** What a JSON check writes for these slots, with sample values: the keys and shapes it takes. */
export function exampleCheckOutput(slots: readonly SlotDefinition[]): string {
  const example = Object.fromEntries(slots.map((slot) => [slot.id, rawSample(sampleValue(slot))]));
  return JSON.stringify(example, null, 2);
}
