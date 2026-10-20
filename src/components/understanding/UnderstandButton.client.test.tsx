import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUnderstandingTour,
  type UnderstandingTourController,
} from '../../lib/create-understanding-tour';
import { UnderstandButton, tourButtonStyle } from './UnderstandButton';
import { tourHintText } from './TourHint';

vi.mock('../../lib/ipc', () => ({ invoke: vi.fn() }));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

function mount(overrides: Partial<UnderstandingTourController> = {}, onClick = vi.fn()) {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(
      () => (
        <UnderstandButton
          label="Take Tour"
          tour={{ ...createUnderstandingTour(), ...overrides }}
          kind="plan"
          subject="docs/plan.md"
          onClick={onClick}
        />
      ),
      container,
    ),
  );
  const button = container.querySelector('button');
  if (!button) throw new Error('No button rendered');
  return { button, onClick };
}

const hint = () => document.querySelector<HTMLElement>('[role="tooltip"]');

describe('UnderstandButton hint', () => {
  it('names the file and what the click does, on focus, and goes away on blur', () => {
    const { button } = mount();
    expect(hint()).toBeNull();

    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const shown = hint();
    expect(shown?.textContent).toContain('Guided tour of this plan');
    expect(shown?.textContent).toContain('docs/plan.md');
    expect(shown?.textContent).toContain('a notification tells you when it is ready');
    expect(shown?.textContent).toContain('Uses: Claude Code');
    expect(button.getAttribute('aria-describedby')).toBe(shown?.id);

    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(hint()).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  it('follows the button state while open', () => {
    const { button } = mount({ isReady: () => true });
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(hint()?.textContent).toContain('Click to open it.');
    expect(hint()?.textContent).not.toContain('Uses:');
  });
});

describe('UnderstandButton split chrome', () => {
  function mountSplit(props: { class?: string; style?: typeof tourButtonStyle }) {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <UnderstandButton
            label="Take Tour"
            tour={createUnderstandingTour()}
            kind="plan"
            subject="docs/plan.md"
            onClick={() => undefined}
            class={props.class}
            style={props.style}
            modelMenu
          />
        ),
        container,
      ),
    );
    const action = container.querySelector<HTMLButtonElement>('button:not([aria-label])');
    const chevron = container.querySelector<HTMLButtonElement>('[aria-label="Tour model"]');
    if (!action || !chevron) throw new Error('Split button did not render both halves');
    return { action, chevron };
  }

  // The pill callers (CanvasTabStrip) must keep the chrome they pass in, and the
  // glued corners that make the pair read as one control.
  it('keeps a caller pill class and flattens the corners where the halves meet', () => {
    const { action, chevron } = mountSplit({
      class: 'btn-secondary review-plan-btn canvas-tour-btn',
      style: tourButtonStyle,
    });

    expect(action.className).toBe('btn-secondary review-plan-btn canvas-tour-btn');
    expect(chevron.className).toBe('btn-secondary review-plan-btn canvas-tour-btn');
    expect(action.style.borderTopRightRadius).toBe('0px');
    expect(action.style.borderBottomRightRadius).toBe('0px');
    expect(chevron.style.borderTopLeftRadius).toBe('0px');
    expect(chevron.style.borderLeftStyle).toBe('none');
  });

  // With no chrome passed, the pair takes the flat footer bar's own classes and
  // brings no inline styles: there are no rounded corners left to flatten.
  it('falls back to the footer bar chrome when the caller passes none', () => {
    const { action, chevron } = mountSplit({});

    expect(action.className).toBe('change-tour-action understanding-action');
    expect(chevron.className).toBe('change-tour-model');
    expect(action.getAttribute('style')).toBeNull();
    expect(chevron.getAttribute('style')).toBeNull();
  });
});

describe('tourHintText', () => {
  const base = {
    subject: 'src/pty.ts',
    loading: false,
    ready: false,
    error: '',
    receiving: false,
    elapsedSeconds: 0,
  };

  it('describes each kind and state', () => {
    expect(tourHintText({ ...base, kind: 'file' }).body).toContain('direct imports');
    expect(tourHintText({ ...base, kind: 'plan' }).body).toContain('key decisions');
    expect(tourHintText({ ...base, kind: 'document' })).toMatchObject({
      heading: 'Guided tour of this document',
      body: expect.stringContaining('what it asks of you'),
    });
    expect(tourHintText({ ...base, kind: 'plan', loading: true, elapsedSeconds: 4 })).toEqual({
      heading: 'Guided tour of this plan',
      body: 'Generating… Waiting for provider · 4s',
      action: 'Click to cancel.',
    });
    expect(
      tourHintText({ ...base, kind: 'file', loading: true, receiving: true, elapsedSeconds: 9 })
        .body,
    ).toBe('Generating… Receiving response · 9s');
    expect(tourHintText({ ...base, kind: 'plan', error: 'Provider unavailable' })).toMatchObject({
      body: 'Provider unavailable',
      action: 'Click to retry.',
    });
    // An agent wrote its cards already, so the idle hint offers to open, not generate.
    expect(tourHintText({ ...base, kind: 'agent', subject: 'the retry bug' })).toEqual({
      heading: 'Tour from the agent',
      body: 'Cards the agent wrote to explain the retry bug.',
      action: 'Click to open it.',
    });
  });
});
