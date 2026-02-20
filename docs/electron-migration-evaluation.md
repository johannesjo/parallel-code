# Evaluation: Migrating from Tauri to Electron for xterm.js Performance

## Executive Summary

**Recommendation: Stay on Tauri v2.** The xterm.js performance bottlenecks in this
codebase are not caused by the framework choice — the app already uses the WebGL
renderer with well-optimized batching. On Windows, Tauri's WebView2 uses the same
Chromium engine as Electron, so WebGL performance is effectively identical. On Linux,
WebKitGTK has known GPU acceleration issues, but Electron would introduce 5-10x
larger binaries and 5-8x higher memory usage to solve a problem that can also be
addressed with targeted workarounds. The cost/benefit does not favor migration.

---

## Current Architecture Assessment

The app's xterm.js integration (`src/components/TerminalView.tsx`) is already
well-optimized:

| Optimization | Implementation |
|---|---|
| WebGL renderer | `@xterm/addon-webgl` v0.19.0 with fallback on context loss |
| Custom base64 decoder | Pre-computed lookup table, avoids `atob()` allocation |
| Output batching | 64KB burst threshold, 8ms interactive timeout |
| Single write callback | One callback per batch, not per chunk |
| RAF deduplication | Shared `requestAnimationFrame` for fit/refresh |
| Input buffering | 8ms flush with 2KB threshold |
| Resize debouncing | 33ms debounce, dedup same cols/rows |
| Backend batching | Rust reader: 65KB chunks, 8ms flush, 16KB read buffer |
| Status analysis cap | Only last 8KB decoded for status parsing |
| Cursor blink control | Disabled for inactive terminals to save RAF loops |

This is a mature, performance-conscious implementation. The primary rendering
bottleneck, if one exists, would be at the webview engine level, not the application
code.

---

## Platform-by-Platform WebGL Analysis

### Windows (WebView2 = Chromium)

Tauri uses Microsoft's WebView2, which is built from the Chromium source — the same
engine Electron bundles. Electron's own documentation confirms: "When it comes to
rendering your web content, we expect little performance difference between Electron,
WebView2, and any other Chromium-based renderer."

**xterm.js WebGL performance: Identical to Electron.**

One caveat: WebView2 defaults to the integrated GPU. Requesting `high-performance`
via WebGL power preference doesn't always switch to the discrete GPU because
"Chromium does not yet support compositing content from different GPUs on Windows."
This affects Electron equally.

### macOS (WKWebView = WebKit)

WKWebView supports WebGL2 on macOS 12+. Performance is generally good — Apple
optimizes WebKit GPU paths for their hardware. Safari's WebGL2 implementation is
mature and hardware-accelerated on Apple Silicon.

**xterm.js WebGL performance: Good, minor differences from Chromium in edge cases.**

Electron would use Chromium's compositor instead, which could be marginally better
for sustained high-throughput rendering. But for a terminal emulator (even one
running multiple panels simultaneously), the difference is negligible — terminals are
not 60fps gaming workloads.

### Linux (WebKitGTK)

This is where Tauri has real problems:

- **WebGL2 availability**: Has been reported as unavailable or broken in some
  WebKitGTK configurations (Tauri issue #2866).
- **GPU acceleration**: WebKitGTK doesn't always leverage hardware acceleration for
  canvas/WebGL operations (Tauri issue #4891). Users report needing
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Nvidia hardware.
- **General sluggishness**: WebKitGTK 2.40+ introduced regressions. The Tauri
  maintainers themselves acknowledge: "if you need good Linux support now I can't
  100% recommend Tauri."
- **Fallback impact**: When WebGL2 fails, xterm.js falls back to the DOM renderer,
  which is dramatically slower for high-throughput output.

**xterm.js WebGL performance: Potentially degraded. Electron would be meaningfully
better on Linux.**

---

## Migration Cost Analysis

### What Migration Requires

| Area | Work Required |
|---|---|
| **Framework swap** | Replace Tauri shell with Electron main process, BrowserWindow, preload scripts |
| **PTY backend** | Rewrite from Rust `portable-pty` to Node.js `node-pty` (or keep Rust via native addon) |
| **IPC layer** | Replace Tauri `invoke()` / `Channel<>` with Electron `ipcMain` / `ipcRenderer` |
| **Shell resolution** | Port `shell.rs` (397 lines) PATH resolution logic to Node.js or keep as native addon |
| **Git operations** | Port `src-tauri/src/git/` Rust code to Node.js or native addon |
| **Task management** | Port `src-tauri/src/tasks/` to Node.js |
| **Build system** | Replace Tauri CLI with electron-builder or electron-forge |
| **State persistence** | Replace Tauri file APIs with Electron equivalents |
| **SolidJS integration** | Use `vite-solid-electron` template pattern (no official solid-start support) |
| **Known SolidJS bug** | `isServer` detection broken with `nodeIntegration: true` — requires workaround |

### What You Lose

| Metric | Tauri v2 | Electron |
|---|---|---|
| **Installer size** | ~3-10 MB | ~80-150 MB |
| **Memory (idle)** | ~30-40 MB | ~200-300 MB |
| **Startup time** | < 500ms | 1-2 seconds |
| **Backend language** | Rust (memory-safe, fast) | Node.js (GC pauses, higher overhead) |
| **Mobile support** | iOS/Android (Tauri v2) | None |
| **Security model** | Rust + CSP + allowlist | Node.js in renderer (larger attack surface) |

### What You Gain

- **Consistent Chromium** on all platforms (no WebKitGTK issues on Linux)
- **Guaranteed WebGL2** support everywhere
- **Larger ecosystem** of Electron plugins and tooling
- **Battle-tested terminal precedent**: VS Code, Hyper, Tabby all use Electron + xterm.js

---

## Alternatives to Full Migration

### 1. Linux-Only: Environment Workarounds (Low Effort)

Set environment variables at launch to force GPU acceleration in WebKitGTK:

```
WEBKIT_DISABLE_DMABUF_RENDERER=1  # Nvidia workaround
LIBGL_ALWAYS_SOFTWARE=0           # Force hardware GL
```

Document these in Linux install instructions. Doesn't fix the underlying WebKitGTK
quality issues but addresses the most common failures.

### 2. Canvas Addon Fallback (Low Effort)

Replace the WebGL addon fallback with `@xterm/addon-canvas` (uses Canvas2D API) instead of
the DOM renderer. Canvas2D is better supported in WebKitGTK than WebGL2, and
significantly faster than the DOM renderer:

```typescript
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  term.loadAddon(webgl);
} catch {
  try {
    const canvas = new CanvasAddon();
    term.loadAddon(canvas);
  } catch {
    // Final fallback: DOM renderer
  }
}
```

### 3. Wait for Tauri + CEF/Chromium (Medium Term)

The Tauri team is actively developing a Chromium Embedded Framework (CEF) backend as
an alternative to WebKitGTK on Linux. This would give Tauri the same Chromium
rendering as Electron without the Electron overhead. No firm timeline, but active
development is underway.

### 4. Hybrid: Rust PTY as Native Addon in Electron (High Effort)

If you do migrate, keep the Rust PTY code as a native Node.js addon (via `napi-rs`)
rather than rewriting to `node-pty`. This preserves your optimized read loop and
base64 batching while getting Electron's Chromium renderer.

---

## Conclusion

| Scenario | Recommendation |
|---|---|
| **Windows users** | Stay on Tauri — WebView2 = Chromium, identical perf |
| **macOS users** | Stay on Tauri — WKWebView WebGL2 works well |
| **Linux users** | Add `@xterm/addon-canvas` fallback now; monitor Tauri CEF progress |
| **Linux is primary target** | Consider Electron, but weigh the 10x bundle/memory cost |
| **Need mobile support** | Stay on Tauri — Electron has no mobile story |

The most impactful immediate change is adding the canvas addon as a middle-ground
fallback between WebGL (fastest) and DOM (slowest). This directly improves the Linux
experience without any framework migration.
