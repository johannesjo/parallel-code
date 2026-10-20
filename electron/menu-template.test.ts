import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate } from './menu-template.js';

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux'];

const build = (platform: NodeJS.Platform): MenuItemConstructorOptions[] =>
  buildMenuTemplate({ platform, appName: 'Parallel Code', onQuit: () => {} });

const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap((item) =>
    Array.isArray(item.submenu) ? [item, ...flatten(item.submenu)] : [item],
  );

describe('buildMenuTemplate', () => {
  // A reload tears down every pane's UI state. Re-adding `role: 'viewMenu'` (or
  // either reload role) would silently bind Cmd/Ctrl+R again, and nothing else
  // in the app would notice until a user reported losing their session.
  describe.each(PLATFORMS)('%s', (platform) => {
    it('registers no reload role', () => {
      const roles = flatten(build(platform)).map((item) => item.role?.toLowerCase());
      expect(roles).not.toContain('reload');
      expect(roles).not.toContain('forcereload');
      // `viewMenu` would drag both reload roles back in wholesale.
      expect(roles).not.toContain('viewmenu');
    });

    it('binds no accelerator to a reload chord', () => {
      const accelerators = flatten(build(platform))
        .map((item) => item.accelerator)
        .filter((accelerator): accelerator is string => Boolean(accelerator));
      for (const accelerator of accelerators) {
        expect(accelerator).not.toMatch(
          /(?:CmdOrCtrl|CommandOrControl|Command|Cmd|Ctrl|Control)\+(?:Shift\+)?R$/i,
        );
      }
    });
  });

  // Snapshot of the top level so a whole submenu cannot appear or vanish
  // unnoticed — Electron's default menu carries a Help submenu this drops.
  it('keeps the macOS top-level menus', () => {
    expect(build('darwin').map((item) => item.label ?? item.role)).toEqual([
      'Parallel Code',
      'File',
      'editMenu',
      'View',
      'windowMenu',
    ]);
  });

  it('keeps the Linux top-level menus', () => {
    expect(build('linux').map((item) => item.label ?? item.role)).toEqual([
      'fileMenu',
      'editMenu',
      'View',
      'windowMenu',
    ]);
  });

  // Cmd+Q is a press-and-hold in the renderer, so the menu item must stay
  // accelerator-free: `role: 'quit'` would bind a one-tap teardown.
  it('leaves the macOS quit item accelerator-free', () => {
    const appMenu = build('darwin')[0];
    const submenu = appMenu.submenu as MenuItemConstructorOptions[];
    const quit = submenu.find((item) => item.label === 'Quit Parallel Code');
    expect(quit).toBeDefined();
    expect(quit?.role).toBeUndefined();
    expect(quit?.accelerator).toBeUndefined();
  });

  it('calls onQuit when the macOS quit item is clicked', () => {
    let quit = 0;
    const template = buildMenuTemplate({
      platform: 'darwin',
      appName: 'Parallel Code',
      onQuit: () => {
        quit += 1;
      },
    });
    const submenu = template[0].submenu as MenuItemConstructorOptions[];
    const item = submenu.find((entry) => entry.label === 'Quit Parallel Code');
    item?.click?.(undefined as never, undefined as never, undefined as never);
    expect(quit).toBe(1);
  });
});
