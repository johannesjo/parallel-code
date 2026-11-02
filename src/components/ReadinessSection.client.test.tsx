import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckSuite } from '../../electron/shared/checks';
import type { VerificationRun } from '../ipc/types';
import type { Task } from '../store/types';
import {
  cancelTaskVerification,
  getCheckSuiteUiState,
  getTaskChecks,
  runTaskVerification,
  stageCheckFailurePrompt,
  stageVerificationFailurePrompt,
} from '../store/store';
import { ReadinessSection } from './ReadinessSection';

const VERIFY = [{ id: 'verify', name: 'Verify', command: 'npm test' }];

vi.mock('../store/store', () => ({
  backgroundVerifyEnabled: vi.fn(() => true),
  cancelTaskVerification: vi.fn(async () => true),
  getBackgroundVerifyHold: vi.fn(() => undefined),
  getCheckSuiteUiState: vi.fn(() => ({})),
  getTaskChecks: vi.fn(() => VERIFY),
  isCheckSuiteBusy: (pkg: { assembling?: boolean }) => Boolean(pkg.assembling),
  runTaskVerification: vi.fn(async () => undefined),
  stageCheckFailurePrompt: vi.fn(() => true),
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
  vi.mocked(getCheckSuiteUiState).mockImplementation(() => ({}));
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
  props: { onStaged?: () => void; hasDetails?: boolean } = {},
) {
  const task = { id: 'task', projectId: 'project', ...overrides } as Task;
  dispose = render(
    () => (
      <ReadinessSection task={task} headSha={HEAD} hasDetails {...props}>
        <div data-testid="body" />
      </ReadinessSection>
    ),
    document.body,
  );
}

describe('ReadinessSection', () => {
  it("shows why the review's check run could not scan the change", () => {
    vi.mocked(getCheckSuiteUiState).mockReturnValue({ error: 'Could not scan the change: boom' });
    mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not scan the change: boom',
    );
  });

  it('says the commit is untested and offers Run, with details folded', () => {
    mount();
    expect(status()).toContain('Not tested on this commit');
    expect(document.querySelector('code')?.textContent).toBe('npm test');
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

  it('offers no Run while a review check run runs verify itself', () => {
    mount({ evidence: { assembling: true, checks: [], scan: { flags: [] } } as never });
    expect(button('Run')).toBeUndefined();
  });

  it('updates in place when a background result lands', () => {
    const [task, setTask] = createStore({ id: 'task', projectId: 'project' } as Task);
    dispose = render(
      () => (
        <ReadinessSection task={task} headSha={HEAD} hasDetails>
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

  it('hides Details when there are no rows behind it', () => {
    mount({}, { hasDetails: false });
    expect(toggle()).toBeNull();
    expect(body()).toBeUndefined();
  });

  it('stages a fix prompt for a failing check verify does not cover', () => {
    const onStaged = vi.fn();
    const evidence = {
      checks: [{ ...run({ status: 'failed', exitCode: 1 }), checkId: 'unit', name: 'Unit' }],
    } as unknown as CheckSuite;
    mount({ verificationRun: run(), evidence }, { onStaged });
    expect(document.body.textContent).toContain('Unit failed');
    button('Stage fix prompt')?.click();
    expect(stageCheckFailurePrompt).toHaveBeenCalledWith('task');
    expect(onStaged).toHaveBeenCalled();
  });

  it('offers configuring checks without a verify command', () => {
    vi.mocked(getTaskChecks).mockReturnValue([]);
    const onConfigure = vi.fn();
    const task = { id: 'task', projectId: 'project' } as Task;
    dispose = render(
      () => (
        <ReadinessSection task={task} headSha={HEAD} hasDetails onConfigure={onConfigure}>
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
