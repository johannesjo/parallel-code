import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenViewer, viewerImages } from './ScreenViewer';

const image = (name: string) => ({
  path: `/out/${name}`,
  dataUrl: `data:image/png;base64,${name}`,
});
const shots = [
  { label: 'Login', before: image('a'), after: image('b') },
  { label: 'Signup', after: image('c') },
];

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
});

const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key }));
const shown = () => document.querySelector('.screen-viewer-stage img')?.getAttribute('alt');
const zoomLabel = () => document.querySelector('.screen-viewer-zoom')?.textContent;

function mount(start: number) {
  const [index, setIndex] = createSignal<number | undefined>(start);
  const onOpenExternal = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <ScreenViewer
        images={viewerImages(shots)}
        index={index()}
        onIndex={setIndex}
        onOpenExternal={onOpenExternal}
      />
    ),
    host,
  );
  return { index, onOpenExternal };
}

describe('viewerImages', () => {
  it('orders each screen before, then after, and skips a missing before', () => {
    expect(viewerImages(shots).map((v) => `${v.label} ${v.side}`)).toEqual([
      'Login Before',
      'Login After',
      'Signup After',
    ]);
  });
});

describe('ScreenViewer', () => {
  it('steps through the images with the arrow keys, wrapping at the ends', () => {
    mount(0);
    expect(shown()).toBe('Login, before');
    press('ArrowRight');
    expect(shown()).toBe('Login, after');
    press('ArrowRight');
    press('ArrowRight');
    expect(shown()).toBe('Login, before');
    press('ArrowLeft');
    expect(shown()).toBe('Signup, after');
  });

  it('keeps the zoom between before and after of one screen, and fits a new screen', () => {
    mount(0);
    press('+');
    expect(zoomLabel()).toBe('125%');
    press('ArrowRight');
    expect(zoomLabel()).toBe('125%');
    press('ArrowRight');
    expect(zoomLabel()).toBe('100%');
    press('+');
    press('0');
    expect(zoomLabel()).toBe('100%');
  });

  it('closes on Escape', () => {
    const { index } = mount(1);
    press('Escape');
    expect(index()).toBeUndefined();
    expect(shown()).toBeUndefined();
  });

  it('opens the shown image in the system viewer', () => {
    const { onOpenExternal } = mount(1);
    document.querySelector<HTMLButtonElement>('[title="Open in the system viewer"]')?.click();
    expect(onOpenExternal).toHaveBeenCalledWith(shots[0].after);
  });
});
