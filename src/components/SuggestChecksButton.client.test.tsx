import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuggestChecksButton } from './SuggestChecksButton';
import { invoke } from '../lib/ipc';
import { startEvidenceModelRequest } from '../lib/evidence-model-request';
import type { CheckSuggestion } from '../lib/check-suggestion';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../lib/evidence-model-request', () => ({ startEvidenceModelRequest: vi.fn() }));
vi.mock('../store/core', () => ({ store: { agentEnvFiles: {} } }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
  vi.mocked(invoke).mockReset();
  vi.mocked(startEvidenceModelRequest).mockReset();
});

function mount(onSuggest: (suggestion: CheckSuggestion) => void): HTMLButtonElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <SuggestChecksButton
        projectRoot="/repo"
        model={{ when: 'off', provider: 'claude' }}
        onSuggest={onSuggest}
      />
    ),
    host,
  );
  const button = host.querySelector('button');
  if (!button) throw new Error('button missing');
  return button;
}

function answer(response: string): void {
  vi.mocked(startEvidenceModelRequest).mockReturnValue({
    result: Promise.resolve(response),
    cancel: vi.fn(),
  });
}

describe('SuggestChecksButton', () => {
  it('sends the project files to the model and fills the form', async () => {
    vi.mocked(invoke).mockResolvedValue([{ path: 'package.json', text: '{"scripts":{}}' }]);
    answer('{"verifyCommand": "npm test", "checks": [], "reason": "From package.json."}');
    const onSuggest = vi.fn();

    mount(onSuggest).click();

    await vi.waitFor(() => expect(onSuggest).toHaveBeenCalled());
    expect(onSuggest).toHaveBeenCalledWith({
      verifyCommand: 'npm test',
      checks: [],
      reason: 'From package.json.',
    });
    expect(vi.mocked(startEvidenceModelRequest).mock.calls[0][0]).toMatchObject({
      cwd: '/repo',
      purpose: 'checks',
    });
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'From package.json. Review the commands before saving.',
    );
  });

  it('reports an empty suggestion without changing the form', async () => {
    vi.mocked(invoke).mockResolvedValue([{ path: 'package.json', text: '{}' }]);
    answer('{"verifyCommand": "", "checks": []}');
    const onSuggest = vi.fn();

    mount(onSuggest).click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(onSuggest).not.toHaveBeenCalled();
  });

  it('does not ask the model once the dialog closed while files were read', async () => {
    let finishRead: (sources: unknown) => void = () => {};
    vi.mocked(invoke).mockReturnValue(new Promise((resolve) => (finishRead = resolve)));

    mount(vi.fn()).click();
    dispose?.();
    dispose = undefined;
    finishRead([{ path: 'package.json', text: '{}' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startEvidenceModelRequest).not.toHaveBeenCalled();
  });

  it('does not ask the model when the project has no build files', async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    mount(vi.fn()).click();

    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('No build'),
    );
    expect(startEvidenceModelRequest).not.toHaveBeenCalled();
  });
});
