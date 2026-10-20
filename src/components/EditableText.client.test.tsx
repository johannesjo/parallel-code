import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { EditableText } from './EditableText';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

describe('EditableText', () => {
  it('keeps the display typography while editing', () => {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => <EditableText value="Task title" onCommit={() => undefined} class="task-heading" />,
        container,
      ),
    );

    const display = container.querySelector('span');
    expect(display?.classList.contains('task-heading')).toBe(true);

    display?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const input = container.querySelector('input');
    expect(input?.classList.contains('task-heading')).toBe(true);
    expect(input?.style.fontSize).toBe('');
    expect(input?.style.fontFamily).toBe('');
    expect(input?.style.fontWeight).toBe('');
  });
});
