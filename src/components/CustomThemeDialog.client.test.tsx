import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { CustomThemeDialog } from './CustomThemeDialog';
import { saveCustomTheme } from '../store/store';

vi.mock('../store/store', () => ({
  store: { appearanceMode: 'dark', customThemes: {} },
  saveCustomTheme: vi.fn(),
  deleteCustomTheme: vi.fn(),
  setDarkTheme: vi.fn(),
  setLightTheme: vi.fn(),
}));
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it('prevents duplicate saves and restores editing after a failed save', async () => {
  let rejectSave: (error: Error) => void = () => {};
  vi.mocked(saveCustomTheme).mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectSave = reject;
      }),
  );
  const onClose = vi.fn();
  dispose = render(
    () => (
      <CustomThemeDialog
        open
        onClose={onClose}
        initialCss={
          '/* name: Test\n terminalBackground: #000 */\n:root { --bg: #000; --fg: #fff; }'
        }
      />
    ),
    document.body,
  );
  const save = document.querySelector<HTMLButtonElement>('.btn-primary');
  save?.click();
  save?.click();
  expect(saveCustomTheme).toHaveBeenCalledOnce();
  expect(save?.disabled).toBe(true);
  expect(save?.textContent).toBe('Saving…');
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Theme CSS"]')?.disabled,
  ).toBe(true);
  document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
  expect(onClose).not.toHaveBeenCalled();
  rejectSave(new Error('Disk full'));
  await vi.waitFor(() => expect(save?.disabled).toBe(false));
  expect(document.body.textContent).toContain('Failed to save theme: Disk full');
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Theme CSS"]')?.disabled,
  ).toBe(false);
});
