/**
 * What an agent sees and sends through `card_list` and `card_publish`: each
 * agent card's slots with the shape a value takes, and the check a published
 * payload passes before it replaces the card's values. See docs/cards.md.
 */

import {
  SLOT_LIMITS,
  isRecord,
  parseSlotValue,
  type SlotDefinition,
  type SlotType,
  type SlotValue,
} from './card-slots';
import { CARD_LIMITS, type CardDefinition } from './cards';

/** Room for keys, quotes and escapes around a value's text, per entry. */
const ENTRY_OVERHEAD = 64;

/**
 * Most JSON characters a slot's published value may take: its type's limits,
 * doubled because escaped quotes and newlines can double any text, plus overhead.
 */
export function slotPayloadChars(slot: SlotDefinition): number {
  const L = SLOT_LIMITS;
  const items = slot.addUp ? L.addUpItems : L.items;
  const budget: Record<SlotType, number> = {
    line: L.line,
    text: L.text,
    score: L.why,
    scores: L.scores * (L.scoreLabel + L.why + L.verified * (L.verifiedText + 8) + ENTRY_OVERHEAD),
    stat: L.unit,
    items: items * (L.itemText + L.file + L.tag + L.detail + ENTRY_OVERHEAD),
    checklist: L.checklist * (L.itemText + ENTRY_OVERHEAD),
    status: L.status * (L.statusText + L.statusValue + ENTRY_OVERHEAD),
  };
  return budget[slot.type] * 2 + ENTRY_OVERHEAD;
}

/** The value a slot takes, in the words `card_list` gives the agent. */
export function slotShape(slot: SlotDefinition): string {
  const L = SLOT_LIMITS;
  const items = slot.addUp ? L.addUpItems : L.items;
  const shapes: Record<SlotType, string> = {
    line: `one line, at most ${L.line} characters`,
    text: `plain text, at most ${L.text} characters`,
    score: `{score: 0-100, why: one line, at most ${L.why} characters}`,
    scores: `1 to ${L.scores} of {label: at most ${L.scoreLabel} characters, score: 0-100, why: one line, verified?: at most ${L.verified} short items}`,
    stat: `{value: number, unit?: at most ${L.unit} characters}`,
    items: `at most ${items} of {text, severity?: "info" | "warn" | "block", file?, tag?: at most ${L.tag} characters, detail?: one line}`,
    checklist: `at most ${L.checklist} of {text, state: "done" | "current" | "todo"}`,
    status: `at most ${L.status} of {state: "ok" | "warn" | "fail" | "running" | "unknown", text, value?}`,
  };
  return shapes[slot.type];
}

/** One agent card as `card_list` returns it. */
export function describeAgentCard(card: CardDefinition) {
  return {
    card: card.id,
    name: card.name,
    ...(card.description && { description: card.description }),
    slots: card.slots.map((slot) => ({
      id: slot.id,
      type: slot.type,
      label: slot.label,
      ...(slot.hint && { hint: slot.hint }),
      value: slotShape(slot),
    })),
  };
}

function checkSlot(slot: SlotDefinition, raw: unknown): SlotValue {
  const chars = JSON.stringify(raw).length;
  const max = slotPayloadChars(slot);
  if (chars > max)
    throw new Error(`Slot "${slot.id}" is too large: ${chars} characters, at most ${max}.`);
  const value = parseSlotValue(slot, raw);
  if (!value) throw new Error(`Slot "${slot.id}" (${slot.type}) needs ${slotShape(slot)}.`);
  return value;
}

/**
 * Checks a published payload against the card's slots: every key must name a
 * slot and every value fit it, else the error names the slot and nothing is
 * kept. Slots left out are empty in the new values.
 */
export function parseCardValues(card: CardDefinition, raw: unknown): Record<string, SlotValue> {
  if (!isRecord(raw)) throw new Error('"values" must be an object keyed by slot id.');
  const values: Record<string, SlotValue> = {};
  for (const [slotId, entry] of Object.entries(raw)) {
    const slot = card.slots.find((candidate) => candidate.id === slotId);
    // The key is the agent's own text and may be long; the slot list is what helps.
    if (!slot)
      throw new Error(
        `Card "${card.id}" has no slot "${slotId.slice(0, CARD_LIMITS.id)}"; its slots are ${card.slots.map((s) => `"${s.id}"`).join(', ')}.`,
      );
    values[slotId] = checkSlot(slot, entry);
  }
  if (!Object.keys(values).length) throw new Error('Send a value for at least one slot.');
  return values;
}
