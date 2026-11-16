/**
 * Describe-to-layout: the one-off request that turns the user's description
 * of a card into a draft definition, and reading the draft back. Only the
 * description and the projects' check names are sent, never task content.
 * See docs/cards.md, "Creating a card".
 */

import { SLOT_LIMITS, SLOT_TYPES, clipLine, isRecord, restoreSlots } from './card-slots';
import { appFactCard } from './app-facts';
import { checkCard } from './check-card';
import {
  APP_FACTS,
  CARD_LIMITS,
  freeCardId,
  restoreCardSource,
  type CardDefinition,
  type ModelInput,
} from './cards';
import { readSingleJsonObject } from './tour-json';

interface CheckName {
  id: string;
  name: string;
}

/** The inputs a drafted model card reads when the draft names none. */
const DEFAULT_INPUTS: ModelInput[] = ['prompts', 'agent-message', 'diff'];

function factLines(): string {
  return APP_FACTS.map((fact) => `- ${fact}: ${appFactCard(fact, true).description}`).join('\n');
}

/** The request for a draft: the sources to choose from, the slot types, then the description. */
export function buildLayoutPrompt(description: string, checks: readonly CheckName[]): string {
  const checkLines = checks.length
    ? checks.map((check) => `- ${check.id}: ${check.name}`).join('\n')
    : '(none)';
  return [
    'Draft a card for a coding task dashboard from the user description below. A card has a name, one source and up to 8 slots.',
    `## Sources\n- {"kind":"app","fact":ID}: free, local facts with a fixed layout. Facts:\n${factLines()}\n- {"kind":"check","checkId":ID}: pass or fail of one project check. Checks:\n${checkLines}\n- {"kind":"model","prompt":string,"trigger":"after-turn"|"manual"|"finish"}: a model reads the task's prompts, the agent's latest message and the diff, and fills the slots following the prompt.\n- {"kind":"agent"}: the coding agent fills the slots itself when asked.`,
    'Prefer an app fact or a check when the description asks for something countable or that a check answers; use a model only for judgement or summaries.',
    `## Slot types\n${SLOT_TYPES.join(', ')}. Each slot: {"id":string [a-z0-9-],"type":TYPE,"label":string,"hint"?:string,"addUp"?:true for items that should add up across turns}. App and check sources ignore slots.`,
    'Return one JSON object: {"name":string,"source":SOURCE,"slots":[SLOT,...]}.',
    `## Description\n${description.trim()}`,
  ].join('\n\n');
}

interface LayoutContext {
  description: string;
  /** Checks of the user's projects; a check draft must name one. */
  checks: readonly CheckName[];
  /** Card ids in use. */
  taken: ReadonlySet<string>;
}

function draftBody(data: Record<string, unknown>, context: LayoutContext) {
  const source = restoreCardSource(data.source);
  if (!source) throw new Error('The draft has no source this app can fill.');
  if (source.kind === 'app') return { source, slots: appFactCard(source.fact, true).slots };
  if (source.kind === 'check') {
    const check = context.checks.find((entry) => entry.id === source.checkId);
    if (!check) throw new Error(`The draft names a check no project has: "${source.checkId}".`);
    // The pass/fail layout only fits exit-code mode; the editor switches to JSON and lays it out.
    // On demand and at Finish, as `checkCard` starts one from the gallery; the editor changes it.
    return {
      source: { ...source, mode: 'exit-code' as const, trigger: 'finish' as const },
      slots: checkCard(check).slots,
    };
  }
  const slots = restoreSlots(data.slots);
  if (!slots.length) throw new Error('The draft has no usable slots.');
  if (source.kind === 'agent') return { source, slots };
  // A drafted model card runs on the default model and reads no check; the editor changes both.
  const { checkId: _checkId, ...rest } = source;
  return {
    source: {
      ...rest,
      model: 'default' as const,
      prompt: source.prompt.trim() || context.description.trim(),
      inputs: source.inputs.length ? source.inputs : DEFAULT_INPUTS,
    },
    slots,
  };
}

/** The draft in a model's answer, as a new card definition; throws a readable error otherwise. */
export function parseLayoutResponse(response: string, context: LayoutContext): CardDefinition {
  let data: unknown;
  try {
    data = readSingleJsonObject(response);
  } catch {
    throw new Error('The model did not return one JSON object.');
  }
  if (!isRecord(data)) throw new Error('The model did not return one JSON object.');
  const { source, slots } = draftBody(data, context);
  const name = clipLine(data.name, CARD_LIMITS.name) || 'New card';
  return {
    id: freeCardId(name, context.taken),
    name,
    description: context.description.trim().slice(0, CARD_LIMITS.description),
    source,
    slots: slots.slice(0, SLOT_LIMITS.slots),
    enabled: true,
    // A check card runs when Finish opens, so its result shows there too, as `checkCard` does.
    ...(source.kind === 'check' && { showAtFinish: true }),
  };
}
