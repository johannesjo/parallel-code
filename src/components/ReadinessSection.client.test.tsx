import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePackage } from '../../electron/shared/evidence';
import type { VerificationRun } from '../ipc/types';
import type { Task } from '../store/types';
import {
  cancelTaskVerification,
  getTaskChecks,
  runTaskVerification,
  stageVerificationFailurePrompt,
} from '../store/store';
import { ReadinessSection } from './ReadinessSection';

const VERIFY = [{ id: 'verify', name: 'Verify', command: 'npm test' }];

vi.mock('../store/store', () => ({
  backgroundVerifyEnabled: vi.fn(() => true),
  cancelTaskVerification: vi.fn(async () => true),
  getBackgroundVerifyHold: vi.fn(() => undefined),
  getEvidenceUiState: vi.fn(() => ({})),
  getProject: vi.fn(() => undefined),
  getTaskChecks: vi.fn(() => VERIFY),
  isEvidenceBusy: (pkg: { assembling?: boolean }) => Boolean(pkg.assembling),
  runTaskVerification: vi.fn(async () => undefined),
  stageVerificationFailurePrompt: vi.fn(() => true),
}));
vi.mock('../lib/theme', () => ({ theme: {} }));

const HEAD = 'a'.repeat(40);

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.mocked(getTaskChecks).mockImplementation(() => VERIFY as never);
});

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
const toggle = () => document.querySelector<HTMLButtonElement>('[aria-expanded]');
const body = () => document.querySelector<HTMLElement>('[data-testid="body"]')?.parentElement;
const status = () => document.querySelector('section')?.textContent ?? '';

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    headSha: HEAD,
    dirty: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    outputTail: '',
    ...overrides,
  };
}

function mount(
  overrides: Partial<Task> = {},
  props: { onStaged?: () => void; onReviewFile?: (file: string) => void } = {},
) {
  const task = { id: 'task', projectId: 'project', ...overrides } as Task;
  dispose = render(
    () => (
      <ReadinessSection task={task} headSha={HEAD} {...props}>
        <div data-testid="body" />
      </ReadinessSection>
    ),
    document.body,
  );
}

describe('ReadinessSection', () => {
  it('says the commit is untested and offers Run, with details folded', () => {
    mount();
    expect(status()).toContain('Not tested on this commit');
    expect(body()?.hidden).toBe(true);
    button('Run')?.click();
    expect(runTaskVerification).toHaveBeenCalledWith('task');
  });

  it('states a pass on this commit', () => {
    mount({ verificationRun: run() });
    expect(status()).toContain('Verify passed');
    expect(status()).toContain('on aaaaaaa');
    // The live region holds the outcome only, not the ticking age or the button.
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Verify passed');
    expect(button('Re-run')).toBeDefined();
  });

  it('stages a fix prompt for a failure, then lets the dialog close', () => {
    const onStaged = vi.fn();
    mount({ verificationRun: run({ status: 'failed', exitCode: 1 }) }, { onStaged });
    button('Stage fix prompt')?.click();
    expect(stageVerificationFailurePrompt).toHaveBeenCalledWith('task');
    expect(onStaged).toHaveBeenCalled();
  });

  it('keeps the dialog open when there was nothing to stage', () => {
    vi.mocked(stageVerificationFailurePrompt).mockReturnValueOnce(false);
    const onStaged = vi.fn();
    mount({ verificationRun: run({ status: 'failed', exitCode: 1 }) }, { onStaged });
    button('Stage fix prompt')?.click();
    expect(onStaged).not.toHaveBeenCalled();
  });

  it('cancels a running check', () => {
    mount({ verificationRun: run({ status: 'running', finishedAt: null }) });
    button('Cancel')?.click();
    expect(cancelTaskVerification).toHaveBeenCalledWith('task');
  });

  it('offers no Run while an evidence build runs verify itself', () => {
    mount({ evidence: { assembling: true, checks: [], scan: { flags: [] } } as never });
    expect(button('Run')).toBeUndefined();
  });

  it('updates in place when a background result lands', () => {
    const [task, setTask] = createStore({ id: 'task', projectId: 'project' } as Task);
    dispose = render(
      () => (
        <ReadinessSection task={task} headSha={HEAD}>
          <div data-testid="body" />
        </ReadinessSection>
      ),
      document.body,
    );
    expect(status()).toContain('Not tested');
    setTask('verificationRun', run());
    expect(status()).toContain('Verify passed');
    expect(body()?.hidden).toBe(true);
  });

  it('expands and folds details on a click', () => {
    mount();
    toggle()?.click();
    expect(body()?.hidden).toBe(false);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.getAttribute('aria-controls')).toBe(body()?.id);
    toggle()?.click();
    expect(body()?.hidden).toBe(true);
  });

  it('surfaces a failing evidence check verify does not cover', () => {
    const evidence = {
      checks: [{ ...run({ status: 'failed', exitCode: 1 }), checkId: 'unit', name: 'Unit' }],
      scan: { flags: [] },
      acceptedFlags: {},
    } as unknown as EvidencePackage;
    mount({ verificationRun: run(), evidence });
    expect(document.body.textContent).toContain('Unit failed');
    button('Show')?.click();
    expect(body()?.hidden).toBe(false);
  });

  it('surfaces a weakened test with a way to review it', () => {
    const onReviewFile = vi.fn();
    const evidence = {
      checks: [],
      scan: {
        flags: [
          {
            id: 'f1',
            category: 'test-weakened',
            rule: 'skip-added',
            file: 'a.test.ts',
            line: 3,
            detail: '.skip added',
          },
        ],
      },
      acceptedFlags: {},
    } as unknown as EvidencePackage;
    mount({ verificationRun: run(), evidence }, { onReviewFile });
    expect(document.body.textContent).toContain('A test was weakened');
    button('Review')?.click();
    expect(onReviewFile).toHaveBeenCalledWith('a.test.ts', 3, 'new');
  });

  it('offers configuring checks without a verify command', () => {
    vi.mocked(getTaskChecks).mockReturnValue([]);
    const onConfigure = vi.fn();
    const task = { id: 'task', projectId: 'project' } as Task;
    dispose = render(
      () => (
        <ReadinessSection task={task} headSha={HEAD} onConfigure={onConfigure}>
          <div data-testid="body" />
        </ReadinessSection>
      ),
      document.body,
    );
    expect(status()).toContain('No verify command');
    button('Configure checks')?.click();
    expect(onConfigure).toHaveBeenCalled();
  });
});
