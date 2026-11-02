import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { addTaskIdea, ideasLaneShown, setIdeasLaneShown } from '../store/ideas';
import { IdeaDialog, ideaDialogOpen, toggleIdeaDialog } from './IdeaDialog';
import { IdeasControl } from './TaskBoardIdeas';
import { IdeasLane } from './TaskBoardIdeasLane';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));

let host: HTMLDivElement;
let dispose: () => void;

function mount(): void {
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <>
        <IdeasControl />
        <IdeasLane query="" />
        <IdeaDialog />
      </>
    ),
    host,
  );
}

// The popover renders in a portal, outside the host.
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
const popover = () => document.querySelector('[role="dialog"][aria-label="Add idea"]');
const lane = () => document.querySelector('.lane-ideas');
const field = () => {
  const input = document.querySelector<HTMLTextAreaElement>('.task-board-idea-input');
  if (!input) throw new Error('no field');
  return input;
};
const projectSelect = () => {
  const select = document.querySelector<HTMLSelectElement>('.task-board-idea-project');
  if (!select) throw new Error('no project select');
  return select;
};
const typeIdea = (text: string) => {
  field().value = text;
  field().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
};
const editField = () => {
  const input = document.querySelector<HTMLTextAreaElement>('.task-board-idea-edit');
  if (!input) throw new Error('no edit field');
  return input;
};
const mouse = (target: Element | undefined, type: string, detail: number) =>
  target?.dispatchEvent(new MouseEvent(type, { detail, bubbles: true, cancelable: true }));
const key = (target: Element, name: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

beforeEach(() => {
  setStore({
    taskIdeas: [],
    projects: [{ id: 'p1', name: 'One', path: '/one', color: '#000' }],
    taskProjectFilter: null,
    lastIdeaProjectId: null,
    showNewTaskPanel: false,
    newTaskPrefillPrompt: null,
  });
  setIdeasLaneShown(false);
});

afterEach(() => {
  // The dialog's state outlives a test's render.
  if (ideaDialogOpen()) toggleIdeaDialog();
  dispose();
  host.remove();
});

describe('Ideas', () => {
  it('adds ideas to the filtered project and shows the lane for the first one', async () => {
    setStore('taskProjectFilter', 'p1');
    mount();
    expect(button('Ideas lane, 0 ideas')).toBeUndefined();
    button('Add idea')?.click();
    await nextFrame();
    const input = document.querySelector<HTMLTextAreaElement>('.task-board-idea-input');
    if (!input) throw new Error('no field');
    expect(document.activeElement).toBe(input);
    input.value = 'Dark mode\nfollow the OS setting';
    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(store.taskIdeas).toEqual([]);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(store.taskIdeas.map((idea) => [idea.text, idea.projectId])).toEqual([
      ['Dark mode\nfollow the OS setting', 'p1'],
    ]);
    expect(input.value).toBe('');
    expect(popover()).not.toBeNull();
    expect(lane()?.textContent).toContain('Dark mode');
    expect(button('Ideas lane, 1 idea')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a hidden lane hidden for later ideas, and the toggle brings it back', () => {
    addTaskIdea('Offline sync', null);
    setIdeasLaneShown(false);
    addTaskIdea('Faster search', null);
    mount();
    expect(ideasLaneShown()).toBe(false);
    expect(lane()).toBeNull();
    button('Ideas lane, 2 ideas')?.click();
    expect(lane()).not.toBeNull();
  });

  it('starts a task from an idea card, or deletes one', () => {
    addTaskIdea('Offline sync', null);
    addTaskIdea('Faster search', null);
    mount();
    button('Delete idea: Faster search')?.click();
    expect(store.taskIdeas.map((idea) => idea.text)).toEqual(['Offline sync']);
    // A double-click's first click opens the editor; the double-click starts.
    mouse(button('Edit idea: Offline sync'), 'click', 1);
    mouse(editField(), 'dblclick', 2);
    expect(store.newTaskPrefillPrompt).toMatchObject({ prompt: 'Offline sync' });
    expect(store.showNewTaskPanel).toBe(true);
    expect(document.querySelector('.task-board-idea-edit')).toBeNull();
  });

  it('edits an idea in place on click, saving on Enter and keeping it on Escape', () => {
    addTaskIdea('Offline sync', null);
    mount();
    mouse(button('Edit idea: Offline sync'), 'click', 1);
    expect(document.activeElement).toBe(editField());
    editField().value = 'Offline sync\nfor notes';
    const shiftEnter = key(editField(), 'Enter', { shiftKey: true });
    expect(shiftEnter.defaultPrevented).toBe(false);
    key(editField(), 'Enter');
    expect(store.taskIdeas.map((idea) => idea.text)).toEqual(['Offline sync\nfor notes']);
    expect(store.showNewTaskPanel).toBe(false);
    expect(document.activeElement).toBe(button('Edit idea: Offline sync\nfor notes'));

    button('Edit idea: Offline sync\nfor notes')?.click();
    editField().value = 'Something else';
    key(editField(), 'Escape');
    expect(document.querySelector('.task-board-idea-edit')).toBeNull();
    expect(document.activeElement).toBe(button('Edit idea: Offline sync\nfor notes'));
    expect(store.taskIdeas.map((idea) => idea.text)).toEqual(['Offline sync\nfor notes']);
  });

  it('saves an edit when the field loses focus, and ignores an emptied one', () => {
    addTaskIdea('Offline sync', null);
    mount();
    button('Edit idea: Offline sync')?.click();
    editField().value = 'Faster sync';
    editField().blur();
    expect(store.taskIdeas.map((idea) => idea.text)).toEqual(['Faster sync']);
    button('Edit idea: Faster sync')?.click();
    editField().value = '   ';
    key(editField(), 'Enter');
    expect(store.taskIdeas.map((idea) => idea.text)).toEqual(['Faster sync']);
  });

  it('opens the editor from the keyboard without arming a double-click start', () => {
    addTaskIdea('Offline sync', null);
    mount();
    mouse(button('Edit idea: Offline sync'), 'click', 0);
    mouse(editField(), 'dblclick', 2);
    expect(store.showNewTaskPanel).toBe(false);
    expect(document.querySelector('.task-board-idea-edit')).not.toBeNull();
  });

  it('selects a word on a double-click inside an open editor instead of starting', () => {
    addTaskIdea('Offline sync', null);
    mount();
    mouse(button('Edit idea: Offline sync'), 'click', 1);
    mouse(editField(), 'mousedown', 1);
    mouse(editField(), 'dblclick', 2);
    expect(store.showNewTaskPanel).toBe(false);
    expect(document.querySelector('.task-board-idea-edit')).not.toBeNull();
  });

  it("starts a task from the card's start button", () => {
    addTaskIdea('Offline sync', 'p1');
    mount();
    button('Start task: Offline sync')?.click();
    expect(store.newTaskPrefillPrompt).toMatchObject({ prompt: 'Offline sync', projectId: 'p1' });
    expect(store.showNewTaskPanel).toBe(true);
  });

  it('hands the keyboard to the next idea when one is deleted', () => {
    addTaskIdea('Offline sync', null);
    addTaskIdea('Faster search', null);
    mount();
    const first = button('Edit idea: Faster search');
    first?.focus();
    first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(store.taskIdeas.map((idea) => idea.text)).toEqual(['Offline sync']);
    expect(document.activeElement).toBe(button('Edit idea: Offline sync'));
  });

  it('drops the lane and its toggle with the last idea', () => {
    addTaskIdea('Offline sync', null);
    mount();
    button('Delete idea: Offline sync')?.click();
    expect(lane()).toBeNull();
    expect(button('Ideas lane, 0 ideas')).toBeUndefined();
  });

  it('closes on Escape and hands the keyboard back to the button', () => {
    mount();
    const trigger = button('Add idea');
    trigger?.click();
    popover()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('picks the project, remembering it for next time unless the board is filtered', () => {
    setStore('projects', 1, { id: 'p2', name: 'Two', path: '/two', color: '#fff' });
    mount();
    button('Add idea')?.click();
    expect(projectSelect().value).toBe('');
    projectSelect().value = 'p2';
    projectSelect().dispatchEvent(new Event('change', { bubbles: true }));
    typeIdea('Offline sync');
    button('Add idea')?.click();

    button('Add idea')?.click();
    expect(projectSelect().value).toBe('p2');
    projectSelect().value = '';
    projectSelect().dispatchEvent(new Event('change', { bubbles: true }));
    typeIdea('Faster search');
    expect(store.taskIdeas.map((idea) => [idea.text, idea.projectId])).toEqual([
      ['Faster search', null],
      ['Offline sync', 'p2'],
    ]);
    button('Add idea')?.click();

    setStore('lastIdeaProjectId', 'p2');
    setStore('taskProjectFilter', 'p1');
    button('Add idea')?.click();
    expect(projectSelect().value).toBe('p1');
  });

  it('keeps a picked project across saves while the board is filtered', () => {
    setStore('projects', 1, { id: 'p2', name: 'Two', path: '/two', color: '#fff' });
    setStore('taskProjectFilter', 'p1');
    mount();
    button('Add idea')?.click();
    projectSelect().value = 'p2';
    projectSelect().dispatchEvent(new Event('change', { bubbles: true }));
    typeIdea('Offline sync');
    typeIdea('Faster search');
    expect(store.taskIdeas.map((idea) => idea.projectId)).toEqual(['p2', 'p2']);
  });

  it('moves between the idea and its project with Alt+Up/Down', () => {
    mount();
    button('Add idea')?.click();
    const altKey = (key: string) =>
      new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true });
    field().focus();
    const down = altKey('ArrowDown');
    field().dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(projectSelect());
    projectSelect().dispatchEvent(altKey('ArrowUp'));
    expect(document.activeElement).toBe(field());
    field().dispatchEvent(altKey('ArrowUp'));
    expect(document.activeElement).toBe(projectSelect());
  });

  it('forgets a remembered project that no longer exists', () => {
    setStore('lastIdeaProjectId', 'gone');
    mount();
    button('Add idea')?.click();
    expect(projectSelect().value).toBe('');
  });

  it('opens from the shortcut away from the board and hands the keyboard back', () => {
    const terminal = document.createElement('textarea');
    document.body.append(terminal);
    terminal.focus();
    dispose = render(() => <IdeaDialog />, (host = document.createElement('div')));
    toggleIdeaDialog();
    expect(popover()).not.toBeNull();
    popover()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(terminal);
    terminal.remove();
  });
});
