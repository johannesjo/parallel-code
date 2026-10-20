import { afterEach, expect, it, vi } from 'vitest';
import { renderMermaidIn } from './mermaid';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('keeps invalid diagram source without leaking Mermaid error graphics into the app', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const container = document.createElement('div');
  const block = document.createElement('div');
  block.className = 'mermaid-block';
  const source = 'graph TD; A[Unfinished';
  block.textContent = source;
  container.append(block);
  document.body.append(container);

  renderMermaidIn(container, 'invalid');

  await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 15000 });
  expect(block.textContent).toBe(source);
  expect(block.querySelector('svg')).toBeNull();
  expect(document.body.children).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Syntax error in text');
}, 15000);
