import { renderToString } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { ProjectSwatch } from './ProjectSwatch';

describe('ProjectSwatch', () => {
  it('renders a rounded square so it never reads as a status dot', () => {
    const html = renderToString(() => ProjectSwatch({ color: 'hsl(210, 70%, 75%)' }));

    expect(html).toContain('border-radius:2px');
    expect(html).not.toContain('border-radius:50%');
    expect(html).toContain('background:hsl(210, 70%, 75%)');
  });

  it('sizes to the text it sits next to and stays out of the accessibility tree', () => {
    const html = renderToString(() => ProjectSwatch({ color: 'red', size: 6 }));

    expect(html).toContain('width:6px');
    expect(html).toContain('height:6px');
    expect(html).toContain('aria-hidden="true"');
  });
});
