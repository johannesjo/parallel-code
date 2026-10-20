import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { buildEvidence, getTaskChecks, runTaskVerification } from '../store/store';
import { ReadinessSection } from './ReadinessSection';

vi.mock('../store/store', () => ({
  buildEvidence: vi.fn(async () => undefined),
  runTaskVerification: vi.fn(async () => undefined),
  getEvidenceUiState: vi.fn(() => ({})),
  isEvidenceBusy: (pkg: { assembling?: boolean }) => Boolean(pkg.assembling),
  getTaskChecks: vi.fn(() => [{ id: 'verify', name: 'Verify', command: 'npm test' }]),
}));
vi.mock('../lib/theme', () => ({ theme: {} }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
const toggle = () => document.querySelector<HTMLButtonElement>('[aria-expanded]');
const body = () => document.querySelector<HTMLElement>('[data-testid="body"]')?.parentElement;

function mount(overrides: Partial<Task> = {}) {
  const task = { id: 'task', projectId: 'project', ...overrides } as Task;
  dispose = render(
    () => (
      <ReadinessSection task={task}>
        <div data-testid="body" />
      </ReadinessSection>
    ),
    document.body,
  );
}

describe('ReadinessSection', () => {
  it('starts folded with the build and run actions in its header', () => {
    mount();
    expect(body()?.hidden).toBe(true);
    expect(button('Build evidence')).toBeDefined();
    expect(button('Run')).toBeDefined();
  });

  it.each([
    ['Build evidence', buildEvidence],
    ['Run', runTaskVerification],
  ] as const)('expands and starts the action on %s', (label, action) => {
    mount();
    button(label)?.click();
    expect(action).toHaveBeenCalledWith(
      'task',
      ...(label === 'Run' ? [] : [{ trigger: 'manual' }]),
    );
    expect(body()?.hidden).toBe(false);
    expect(button('Build evidence')).toBeUndefined();
  });

  it('expands and folds on a header click', () => {
    mount();
    toggle()?.click();
    expect(body()?.hidden).toBe(false);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.getAttribute('aria-controls')).toBe(body()?.id);
    toggle()?.click();
    expect(body()?.hidden).toBe(true);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it.each<Partial<Task>>([
    { evidence: {} as Task['evidence'] },
    { verificationRun: {} as Task['verificationRun'] },
  ])('starts open once evidence or a check run exists: %j', (overrides) => {
    mount(overrides);
    expect(body()?.hidden).toBe(false);
  });

  // Auto-evidence or an agent's check can finish while the dialog is open; a
  // failure it reports must not stay folded away.
  it.each<Partial<Task>>([
    { evidence: {} as Task['evidence'] },
    { verificationRun: { status: 'failed' } as Task['verificationRun'] },
  ])('opens when evidence or a check run arrives while folded: %j', (update) => {
    const [task, setTask] = createStore({ id: 'task', projectId: 'project' } as Task);
    dispose = render(
      () => (
        <ReadinessSection task={task}>
          <div data-testid="body" />
        </ReadinessSection>
      ),
      document.body,
    );
    expect(body()?.hidden).toBe(true);
    setTask(update);
    expect(body()?.hidden).toBe(false);
  });

  it('hides Run without a verify command', () => {
    vi.mocked(getTaskChecks).mockReturnValueOnce([]);
    mount();
    expect(button('Run')).toBeUndefined();
  });

  it.each<Partial<Task>>([
    { evidence: { assembling: true } as Task['evidence'] },
    { verificationRun: { status: 'running' } as Task['verificationRun'] },
  ])('offers no header actions while work is running, even when folded: %j', (overrides) => {
    mount(overrides);
    toggle()?.click();
    expect(body()?.hidden).toBe(true);
    expect(button('Build evidence')).toBeUndefined();
    expect(button('Run')).toBeUndefined();
  });
});
