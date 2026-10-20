import { createEffect, createSignal, on } from 'solid-js';
import { createCardWriter } from '../../lib/create-card-writer';
import type { UnderstandingTourController } from '../../lib/create-understanding-tour';
import {
  MAX_TOUR_DEPTH,
  createNodeIds,
  findNode,
  previousNodeId,
  type TourNode,
} from '../../lib/tour-tree';
import {
  applyWrittenCards,
  blankCard,
  editableText,
  insertAfter,
  insertChild,
  isBlankCard,
  outdent,
  replaceCard,
  withText,
} from '../../lib/tour-tree-edit';
import type { TourCard } from '../../lib/understanding-tour';
import type { ThinkingAction, ThinkingMove } from './ThinkingCard';

/**
 * The card an Alt arrow goes to: left and right along the cards at this level
 * (left climbs to the parent from a first follow-up), down into the first
 * follow-up and up out to the card followed up on.
 */
function moveTarget(
  roots: readonly TourNode[],
  trail: readonly TourNode[],
  move: ThinkingMove,
): string | undefined {
  const current = trail.at(-1);
  if (!current) return undefined;
  const parent = trail.at(-2);
  if (move === 'up') return parent?.id;
  if (move === 'down') return current.children[0]?.id;
  if (move === 'left') return previousNodeId(roots, current.id);
  const level = parent ? parent.children : roots;
  return level[level.findIndex((node) => node.id === current.id) + 1]?.id;
}

/**
 * The reader's side of a tour they write: whether they are typing, which view
 * is open and what the keys typed into a card do. The controller owns the
 * tree; this only turns keys into edits of it.
 */
export function createThinkingControls(options: {
  tour: () => UnderstandingTourController;
  worktreePath: () => string;
  /** Hands focus back to the tour once typing ends. */
  onDone: () => void;
  /** Leaves the tour, as Escape does once typing has ended. */
  onClose: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [focus, setFocus] = createSignal<'title' | 'body'>('body');
  const [map, setMap] = createSignal(false);
  const writer = createCardWriter();
  const controller = () => options.tour();
  const currentId = () => controller().currentId();

  // A card left blank is dropped as soon as the reader moves on from it.
  createEffect(
    on(currentId, (_id, left) => {
      if (left && controller().thinking()) controller().dropIfBlank(left);
    }),
  );

  // A blank tour opens ready to type its title.
  createEffect(
    on(
      () => controller().thinking() && controller().tour(),
      (shown) => {
        writer.cancel();
        writer.dismiss();
        setMap(false);
        const only = controller().tree();
        const blank = shown && only.length === 1 && isBlankCard(only[0].card);
        setFocus(blank ? 'title' : 'body');
        setEditing(Boolean(blank));
      },
    ),
  );

  function startEditing(): void {
    setFocus(controller().currentNode()?.card.title ? 'body' : 'title');
    setEditing(true);
  }

  /** A key typed while reading starts typing on the card, beginning with that key. */
  function typeKey(key: string): void {
    const card = controller().currentNode()?.card;
    if (!card) return;
    const field = card.title ? 'body' : 'title';
    change(field === 'body' ? withText(card, editableText(card) + key) : { ...card, title: key });
    setFocus(field);
    setEditing(true);
  }

  function stopEditing(): void {
    // Nothing written yet leaves nothing to read: Escape leaves straight away.
    const roots = controller().tree();
    if (roots.length === 1 && isBlankCard(roots[0].card) && !roots[0].children.length) {
      options.onClose();
      return;
    }
    setEditing(false);
    options.onDone();
  }

  /** Adds a blank card where `place` puts it and starts typing its title. */
  function addCard(place: (roots: TourNode[], id: string, node: TourNode) => TourNode[]): void {
    const roots = controller().tree();
    const node: TourNode = { id: createNodeIds(roots)(), card: blankCard(), children: [] };
    const next = place(roots, currentId(), node);
    if (!findNode(next, node.id)) return;
    setFocus('title');
    controller().edit(next, node.id);
  }

  /**
   * Goes to the card `move` points at, still typing if the reader was. Past the
   * last card right adds the next one, and down adds the first follow-up.
   */
  function go(move: ThinkingMove): void {
    const current = controller().currentNode();
    if (!current) return;
    const target = moveTarget(controller().tree(), controller().trail(), move);
    if (target) {
      // The card mounts focused on select, so its field is picked first.
      setFocus(findNode(controller().tree(), target)?.card.title ? 'body' : 'title');
      controller().select(target);
      return;
    }
    if (move !== 'right' && move !== 'down') return;
    act(move === 'right' ? 'sibling' : 'child');
    setEditing(true);
  }

  function act(action: ThinkingAction): void {
    const current = controller().currentNode();
    if (!current) return;
    if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
      go(action);
      return;
    }
    // A blank card has nothing to follow up on or come after.
    const blank = isBlankCard(current.card);
    if (action === 'done') stopEditing();
    else if (action === 'sibling' && !blank) addCard(insertAfter);
    else if (action === 'child' && !blank && controller().trail().length < MAX_TOUR_DEPTH)
      addCard(insertChild);
    else if (action === 'outdent') controller().edit(outdent(controller().tree(), current.id));
    else if (action === 'write') write();
    else if (action === 'map') toggleMap();
  }

  function write(): void {
    const current = controller().currentNode();
    if (!current || isBlankCard(current.card)) return;
    void writer.write({
      roots: controller().tree(),
      nodeId: current.id,
      cwd: options.worktreePath(),
    });
  }

  function change(card: TourCard): void {
    // A card written from the notes as they were would overwrite this typing.
    if (writer.writingId() === currentId()) writer.cancel();
    controller().edit(replaceCard(controller().tree(), currentId(), card));
  }

  function accept(): void {
    const proposal = writer.proposal();
    if (!proposal) return;
    const roots = controller().tree();
    const nextId = createNodeIds(roots);
    controller().edit(applyWrittenCards(roots, proposal.nodeId, { cards: proposal.cards, nextId }));
    writer.dismiss();
    stopEditing();
  }

  function reject(): void {
    writer.dismiss();
    if (!editing()) options.onDone();
  }

  /** The map's edits as cards; the tour keeps a card to show and write on. */
  function fromMap(roots: TourNode[]): void {
    const next = roots.length
      ? roots
      : [{ id: createNodeIds()(), card: blankCard(), children: [] }];
    controller().edit(next, findNode(next, currentId()) ? undefined : next[0].id);
  }

  function toggleMap(): void {
    setEditing(false);
    writer.dismiss();
    setMap((open) => !open);
  }

  return {
    editing,
    focus,
    map,
    writer,
    startEditing,
    typeKey,
    act,
    write,
    change,
    accept,
    reject,
    fromMap,
    toggleMap,
  };
}
