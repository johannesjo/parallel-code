import { describe, expect, it, vi } from 'vitest';
import { renderMermaidIn } from './mermaid';

const rendered: string[] = [];

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: async (id: string, source: string) => {
      rendered.push(source);
      return { svg: `<svg id="${id}"></svg>` };
    },
  },
}));

async function waitFor<T>(probe: () => T | null | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition never became true');
}

function host(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

describe('renderMermaidIn', () => {
  it('renders a diagram whose data attribute the sanitizer stripped', async () => {
    rendered.length = 0;
    // What DOMPurify leaves of the placeholder: an arrow in the source means
    // the whole data-mermaid attribute is dropped, the text stays.
    const container = host('<div class="mermaid-block">graph TD;\n  A--&gt;B</div>');

    renderMermaidIn(container, 'k');

    await waitFor(() => container.querySelector('.mermaid-block.mermaid-rendered'));
    expect(rendered).toEqual(['graph TD;\n  A-->B']);
    expect(container.querySelector('.mermaid-block')?.innerHTML).toContain('<svg');
  });

  it('still prefers the data attribute when it survived', async () => {
    rendered.length = 0;
    const container = host(
      '<div class="mermaid-block" data-mermaid="graph TD; A---B">placeholder text</div>',
    );

    renderMermaidIn(container, 'k');

    await waitFor(() => container.querySelector('.mermaid-block.mermaid-rendered'));
    expect(rendered).toEqual(['graph TD; A---B']);
  });

  it('leaves an empty placeholder alone', async () => {
    rendered.length = 0;
    const container = host('<div class="mermaid-block">   </div>');

    renderMermaidIn(container, 'k');

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rendered).toEqual([]);
    expect(container.querySelector('.mermaid-rendered')).toBeNull();
  });
});
