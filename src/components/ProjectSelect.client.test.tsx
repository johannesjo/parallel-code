import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { setStore } from '../store/core';
import { ProjectSelect } from './ProjectSelect';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore('projects', []);
});

describe('ProjectSelect', () => {
  it('lists projects alphabetically by name', () => {
    setStore('projects', [
      { id: 'zulu', name: 'Zulu', path: '/zulu', color: '' },
      { id: 'alpha', name: 'alpha', path: '/alpha', color: '' },
      { id: 'beta', name: 'Beta', path: '/beta', color: '' },
    ]);
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(() => <ProjectSelect value={null} onChange={() => undefined} />, container),
    );

    expect(
      Array.from(container.querySelectorAll('option'), (option) => option.textContent),
    ).toEqual(['alpha — /alpha', 'Beta — /beta', 'Zulu — /zulu']);
  });
});
