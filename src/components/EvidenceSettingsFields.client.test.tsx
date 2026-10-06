import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EVIDENCE_MODEL } from '../../electron/shared/evidence-settings';
import { EvidenceSettingsFields, type CheckDraft } from './EvidenceSettingsFields';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

function mount(initial: CheckDraft[]) {
  const [checks, setChecks] = createSignal<CheckDraft[]>(initial);
  dispose = render(
    () => (
      <EvidenceSettingsFields
        checks={checks()}
        onChecksChange={setChecks}
        model={DEFAULT_EVIDENCE_MODEL}
        onModelChange={() => {}}
        autoBuild={false}
        onAutoBuildChange={() => {}}
      />
    ),
    document.body,
  );
  return checks;
}

const commandInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Check command"]');

function type(input: HTMLInputElement, text: string) {
  for (const char of text) {
    input.value += char;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

describe('EvidenceSettingsFields', () => {
  it('keeps the same field while typing a command', () => {
    const checks = mount([{ kind: 'unit', command: '', run: 'auto' }]);
    const input = commandInput();
    if (!input) throw new Error('missing command input');
    type(input, 'npm test');
    // A re-created row would drop focus after the first keystroke.
    expect(commandInput()).toBe(input);
    expect(checks()[0]?.command).toBe('npm test');
  });

  it('turns background builds on', () => {
    const onAutoBuildChange = vi.fn();
    dispose = render(
      () => (
        <EvidenceSettingsFields
          checks={[]}
          onChecksChange={() => {}}
          model={DEFAULT_EVIDENCE_MODEL}
          onModelChange={() => {}}
          autoBuild={false}
          onAutoBuildChange={onAutoBuildChange}
        />
      ),
      document.body,
    );
    const box = [...document.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('in the background'))
      ?.querySelector('input');
    box?.click();
    expect(onAutoBuildChange).toHaveBeenCalledWith(true);
  });

  it('names checks after their kind', () => {
    mount([{ kind: 'e2e', command: 'npm run e2e', run: 'auto' }]);
    expect(document.querySelector('input[aria-label="Check name"]')).toBeNull();
    expect(
      document.querySelector<HTMLSelectElement>('select[aria-label="Check kind"]')?.value,
    ).toBe('e2e');
  });
});
