// Regression test for issue #121: garbled glyphs in background terminals on macOS.
//
// Terminals with the same font and theme share one WebGL glyph atlas, but each
// keeps its own GPU copy of every atlas page and re-uploads a page only when
// its version number changes. When the atlas reaches the GPU's texture-unit
// limit (16 on Apple GPUs, often 32 elsewhere) it merges pages and shifts the
// rest down an index. @xterm/addon-webgl before 0.20.0-beta.330 counted
// versions per page, so the page that moved into a slot could carry the same
// number as the one that left it: that terminal kept the old texture and drew
// its cells from the wrong page until something else bumped the version.
// Neither refresh() nor clearTextureAtlas() reliably recovered it.
//
// The test drives two terminals sharing an atlas in real Chromium WebGL, with
// the texture-unit limit forced to 16, and checks after every rendered frame
// that each texture unit holds the canvas of the atlas page at that index.
// It needs a Chromium for Playwright, so it is opt-in:
//   npm run test:webgl-atlas
/* global process, URL, window, document, requestAnimationFrame, WebGL2RenderingContext, HTMLCanvasElement */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RUN = process.env.RUN_WEBGL_ATLAS_TEST === '1';
const describeWebgl = RUN ? describe : describe.skip;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

async function bundleXterm() {
  const result = await build({
    stdin: {
      contents: `
        import { Terminal } from '@xterm/xterm';
        import { WebglAddon } from '@xterm/addon-webgl';
        window.Terminal = Terminal;
        window.WebglAddon = WebglAddon;
      `,
      resolveDir: repoRoot,
    },
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/** Runs in the page before any script: fakes a 16-unit GPU and records uploads. */
function instrumentWebgl() {
  const proto = WebGL2RenderingContext.prototype;
  const getParameter = proto.getParameter;
  proto.getParameter = function (pname) {
    return pname === this.MAX_TEXTURE_IMAGE_UNITS ? 16 : getParameter.call(this, pname);
  };
  const state = new WeakMap();
  const stateOf = (gl) => {
    let s = state.get(gl);
    if (!s) {
      s = { unit: 0, uploads: [] };
      state.set(gl, s);
    }
    return s;
  };
  const activeTexture = proto.activeTexture;
  proto.activeTexture = function (unit) {
    stateOf(this).unit = unit - this.TEXTURE0;
    return activeTexture.call(this, unit);
  };
  const texImage2D = proto.texImage2D;
  proto.texImage2D = function (...args) {
    const source = args[args.length - 1];
    if (source instanceof HTMLCanvasElement) stateOf(this).uploads[stateOf(this).unit] = source;
    return texImage2D.apply(this, args);
  };
  window.__webglState = stateOf;
}

/** Runs in the page. Uses addon internals: there is no public API for any of this. */
async function driveTerminals(iterations) {
  let seed = 4;
  const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x80000000;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const write = (term, data) => new Promise((r) => term.write(data, r));
  const make = (id) => {
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'width:900px;height:400px';
    document.body.append(el);
    const term = new window.Terminal({
      fontSize: 13,
      fontFamily: 'monospace',
      cols: 110,
      rows: 24,
    });
    term.open(el);
    const addon = new window.WebglAddon();
    term.loadAddon(addon);
    return { term, addon };
  };
  const busy = make('busy');
  const background = make('background');
  let merges = 0;
  busy.addon.onRemoveTextureAtlasCanvas(() => merges++);
  const units = document.createElement('canvas').getContext('webgl2');
  const textureUnits = units?.getParameter(units.MAX_TEXTURE_IMAGE_UNITS);

  // Cells drawn from a texture unit that does not hold the page they point into.
  const staleCells = { busy: 0, background: 0 };
  const check = (name, { addon }) => {
    const renderer = addon._renderer;
    const atlas = renderer?._charAtlas;
    const glyphs = renderer?._glyphRenderer?.value;
    if (!atlas || !glyphs) return;
    const { uploads } = window.__webglState(renderer._gl);
    const stale = new Set();
    const pages = Math.min(atlas.pages.length, glyphs._atlasTextures.length);
    for (let i = 0; i < pages; i++) if (uploads[i] !== atlas.pages[i].canvas) stale.add(i);
    if (!stale.size) return;
    const attrs = glyphs._vertices.attributes;
    // 11 floats per cell: [2] is the glyph width (0 = empty cell), [4] its texture page.
    for (let k = 0; k < attrs.length; k += 11) {
      if (attrs[k + 2] > 0 && stale.has(attrs[k + 4])) staleCells[name]++;
    }
  };
  busy.term.onRender(() => check('busy', busy));
  background.term.onRender(() => check('background', background));

  let screen = '';
  for (let y = 0; y < 22; y++) {
    screen += `\x1b[38;2;200;200;200mline ${y} the quick brown fox jumps over the lazy dog 0123456789 ~!@#$%^&*()\r\n`;
  }
  await write(background.term, screen);

  for (let i = 0; i < iterations; i++) {
    // Agent output with many distinct truecolor glyphs keeps adding atlas pages.
    let out = '';
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 110; x++) {
        const char = String.fromCharCode(33 + Math.floor(rand() * 94));
        const [r, g, b] = [rand(), rand(), rand()].map((v) => Math.floor(v * 256));
        out += `\x1b[38;2;${r};${g};${b}m${char}`;
      }
      if (y < 23) out += '\r\n';
    }
    await write(busy.term, out);
    // The background pane only repaints its status line now and then.
    if (i % 10 === 0) {
      await write(
        background.term,
        `\x1b[24;1H\x1b[38;2;120;200;255mstatus ${i} ctx 42% tokens ${i * 37}`,
      );
    }
    await frame();
    if (staleCells.background > 0) break;
  }
  // Repaint the background pane the way foregrounding it does.
  background.term.refresh(0, background.term.rows - 1);
  await frame();
  return {
    merges,
    staleCells,
    textureUnits,
    instrumented: typeof window.__webglState === 'function',
  };
}

describeWebgl('xterm WebGL atlas shared between terminals (#121)', () => {
  it('never draws cells from a texture unit holding a different atlas page', async () => {
    const version = JSON.parse(
      readFileSync(require.resolve('@xterm/addon-webgl/package.json'), 'utf8'),
    ).version;
    const script = await bundleXterm();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 920, height: 820 } });
      await page.addInitScript(instrumentWebgl);
      // Init scripts run on navigation; setContent alone would skip them.
      await page.goto('data:text/html,<!doctype html><body style="margin:0"></body>');
      await page.addStyleTag({
        content: readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8'),
      });
      await page.addScriptTag({ content: script });
      const { merges, staleCells, textureUnits, instrumented } = await page.evaluate(
        driveTerminals,
        160,
      );
      // Without the instrumentation or page merges the scenario would prove nothing.
      expect(instrumented).toBe(true);
      expect(textureUnits).toBe(16);
      expect(merges, `addon-webgl ${version}`).toBeGreaterThan(0);
      expect(staleCells, `addon-webgl ${version}`).toEqual({ busy: 0, background: 0 });
    } finally {
      await browser.close();
    }
  }, 180_000);
});
