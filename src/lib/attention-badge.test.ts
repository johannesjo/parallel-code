import { expect, it, vi } from 'vitest';
import { attentionTaskCount } from './attention-badge';

vi.mock('./ipc', () => ({ invoke: vi.fn() }));
vi.mock('../store/sidebar-attention', () => ({
  computeAttentionEntries: () => [
    { key: 'q', kind: 'question', taskId: 'a', label: '', panel: null, changes: [] },
    { key: 'r', kind: 'review', taskId: 'a', label: '', panel: null, changes: [] },
    { key: 'q2', kind: 'question', taskId: 'b', label: '', panel: null, changes: [] },
  ],
}));

it('counts each waiting task once, however many reasons it has', () => {
  expect(attentionTaskCount()).toBe(2);
});
