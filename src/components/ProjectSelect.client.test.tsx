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
  it('shows each project color next to its label', () => {
    setStore('projects', [
      { id: 'alpha', name: 'Alpha', path: '/alpha', color: 'rgb(255, 0, 0)' },
      { id: 'beta', name: 'Beta', path: '/beta', color: 'rgb(0, 0, 255)' },
    ]);
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(() => <ProjectSelect value="alpha" onChange={() => undefined} />, container),
    );

    const options = container.querySelectorAll('option');
    expect(options[0].querySelector<HTMLElement>('.project-swatch')?.style.background).toBe(
      'rgb(255, 0, 0)',
    );
    expect(options[1].querySelector<HTMLElement>('.project-swatch')?.style.background).toBe(
      'rgb(0, 0, 255)',
    );
  });

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
    ).toEqual(['alpha', 'Beta', 'Zulu']);
  });

  it('appends the project path when showPath is set', () => {
    setStore('projects', [{ id: 'alpha', name: 'Alpha', path: '/alpha', color: '' }]);
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(() => <ProjectSelect value={null} onChange={() => undefined} showPath />, container),
    );

    expect(container.querySelector('option')?.textContent).toBe('Alpha — /alpha');
  });
});
