import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BINDINGS } from './keybindings/defaults';
import {
  initShortcuts,
  registerFromRegistry,
  registerJumpToTaskShortcuts,
  registerZoomShortcuts,
} from './shortcuts';

type KeyboardEventStub = Pick<
  KeyboardEvent,
  | 'altKey'
  | 'ctrlKey'
  | 'key'
  | 'metaKey'
  | 'preventDefault'
  | 'shiftKey'
  | 'stopPropagation'
  | 'target'
  | 'composedPath'
>;

describe('registerFromRegistry — jump-to-task bindings', () => {
  let keydownHandler: ((event: KeyboardEvent) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: EventListenerOrEventListenerObject) => {
        if (type === 'keydown' && typeof handler === 'function') {
          keydownHandler = handler as (event: KeyboardEvent) => void;
        }
      },
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    keydownHandler = undefined;
    vi.unstubAllGlobals();
  });

  it('opens second opinion from terminal input but suppresses it while a dialog is open', () => {
    const handler = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { secondOpinion: handler });
    const cleanupShortcuts = initShortcuts();
    const event: KeyboardEventStub = {
      key: 'O',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      target: { tagName: 'TEXTAREA' } as unknown as EventTarget,
      composedPath: () => [{ tagName: 'TEXTAREA' }] as unknown as EventTarget[],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    try {
      keydownHandler?.(event as KeyboardEvent);
      expect(handler).toHaveBeenCalledOnce();
      expect(event.preventDefault).toHaveBeenCalledOnce();
      vi.stubGlobal('document', { querySelector: () => ({}) });
      keydownHandler?.(event as KeyboardEvent);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      cleanupRegistry();
      cleanupShortcuts();
    }
  });

  it('skips Escape a menu already handled, but fires an unhandled one', () => {
    const closeDialogs = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { closeDialogs });
    const cleanupShortcuts = initShortcuts();
    const escape = (defaultPrevented: boolean) =>
      ({
        key: 'Escape',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented,
        target: { tagName: 'DIV' },
        composedPath: () => [{ tagName: 'DIV' }],
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }) as unknown as KeyboardEvent;
    try {
      keydownHandler?.(escape(true));
      expect(closeDialogs).not.toHaveBeenCalled();
      keydownHandler?.(escape(false));
      expect(closeDialogs).toHaveBeenCalledOnce();
    } finally {
      cleanupRegistry();
      cleanupShortcuts();
    }
  });

  it('zooms in and out from the registry bindings', () => {
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { zoomIn, zoomOut });
    const cleanupShortcuts = initShortcuts();
    const ctrl = (key: string) =>
      ({
        key,
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        target: { tagName: 'TEXTAREA' },
        composedPath: () => [{ tagName: 'TEXTAREA' }],
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }) as unknown as KeyboardEvent;
    try {
      keydownHandler?.(ctrl('='));
      keydownHandler?.(ctrl('-'));
      expect(zoomIn).toHaveBeenCalledOnce();
      expect(zoomOut).toHaveBeenCalledOnce();
    } finally {
      cleanupRegistry();
      cleanupShortcuts();
    }
  });

  it('fires jumpToTask:1 handler on Ctrl+1 (key="1") on non-Mac platforms', () => {
    const handler = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { 'jumpToTask:1': handler });
    const cleanupShortcuts = initShortcuts();

    const event: Pick<
      KeyboardEvent,
      | 'key'
      | 'ctrlKey'
      | 'metaKey'
      | 'altKey'
      | 'shiftKey'
      | 'target'
      | 'composedPath'
      | 'preventDefault'
      | 'stopPropagation'
    > = {
      key: '1',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: null,
      composedPath: () => [],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(handler).toHaveBeenCalledTimes(1);

    cleanupShortcuts();
    cleanupRegistry();
  });

  it('fires jumpToTask handler on Ctrl+Shift+1 via registerJumpToTaskShortcuts (AZERTY)', () => {
    const handler = vi.fn();
    const cleanupJump = registerJumpToTaskShortcuts(handler);
    const cleanupShortcuts = initShortcuts();

    const event: Pick<
      KeyboardEvent,
      | 'key'
      | 'ctrlKey'
      | 'metaKey'
      | 'altKey'
      | 'shiftKey'
      | 'target'
      | 'composedPath'
      | 'preventDefault'
      | 'stopPropagation'
    > = {
      key: '1',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      target: null,
      composedPath: () => [],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(0);

    cleanupShortcuts();
    cleanupJump();
  });

  it('does NOT fire cmdOrCtrl bindings for Meta on non-Mac platforms', () => {
    const handler = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { 'jumpToTask:1': handler });
    const cleanupShortcuts = initShortcuts();

    const event: KeyboardEventStub = {
      key: '1',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      target: null,
      composedPath: () => [],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(handler).not.toHaveBeenCalled();

    cleanupShortcuts();
    cleanupRegistry();
  });

  it('does NOT fire when key is "Digit1" (old broken binding format)', () => {
    const handler = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { 'jumpToTask:1': handler });
    const cleanupShortcuts = initShortcuts();

    const event: Pick<
      KeyboardEvent,
      | 'key'
      | 'ctrlKey'
      | 'metaKey'
      | 'altKey'
      | 'shiftKey'
      | 'target'
      | 'composedPath'
      | 'preventDefault'
      | 'stopPropagation'
    > = {
      key: 'Digit1',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      target: null,
      composedPath: () => [],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(handler).not.toHaveBeenCalled();

    cleanupShortcuts();
    cleanupRegistry();
  });
});

describe('registerZoomShortcuts', () => {
  let keydownHandler: ((event: KeyboardEvent) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: EventListenerOrEventListenerObject) => {
        if (type === 'keydown' && typeof handler === 'function') {
          keydownHandler = handler as (event: KeyboardEvent) => void;
        }
      },
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    keydownHandler = undefined;
    vi.unstubAllGlobals();
  });

  it('resets zoom for shifted Ctrl+0 layouts', () => {
    const resetZoom = vi.fn();
    const cleanupZoomShortcuts = registerZoomShortcuts({
      zoomIn: vi.fn(),
      resetZoom,
    });
    const cleanupShortcuts = initShortcuts();

    const event: KeyboardEventStub = {
      key: '0',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      target: null,
      composedPath: () => [],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(resetZoom).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);

    cleanupShortcuts();
    cleanupZoomShortcuts();
  });
});
