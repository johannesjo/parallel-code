# Browser preview

Open a task's canvas using its title-bar button, then choose **+ → Browser**. Start your dev server in the task shell (or with an existing terminal bookmark), enter its HTTP/HTTPS address, and press **Go**. `localhost:5173` and `127.0.0.1:3000` also work without a scheme. Each task has one browser tab and remembers its last address across restarts.

Click **Pick element**, hover to highlight an element, and click to add its URL, selector, visible text, and a short HTML excerpt to the task's prompt. The selection click does not activate the element. **Escape** or **Cancel picker** leaves picking mode. References append to the existing draft; they do not send a prompt. Review the draft and send it when ready.

## First-version limits

- Start servers and manage worktree ports through the existing task shells. There is no server launcher, automatic port detection, or browser automation tool for agents.
- References describe the current DOM, not framework components or source-file locations. Selectors are best effort and can become stale after a rerender. `>>>` in a reference denotes an open shadow-root boundary, not a CSS combinator.
- The picker supports the main document and open shadow roots. It cannot pick inside iframes or closed shadow roots.
- Popups, downloads, and device/clipboard permission requests are denied. Sessions are separate from the app and from other tasks, and are not persisted to disk. Closing the tab releases its page and history; the last URL is kept. Reopening starts with fresh site data (including cookies and login state).
- The native page is hidden during app dialogs/menus and layout drags, and when its viewport is clipped. Scroll the browser fully into view to display it again. Switching canvas tabs keeps the page alive; closing the tab, task, or window disposes it.

## Implementation

`TaskBrowserPanel` draws the controls and reports the page rectangle over IPC. The main process owns the `WebContentsView`; URL validation and sender checks happen there. Bounds are converted from renderer CSS pixels using the app's zoom factor. The app and guest use separate preloads: `browser-preload.cjs` exposes no API to the page and only returns a user-picked element while the main process has armed the picker. Captured excerpts are bounded and omit form values and arbitrary attributes. Text is also omitted when the selection is inside or contains an editable region or form control. Native guest focus activates its task without moving keyboard focus back to the app. URL history changes use the existing debounced autosave.

Electron retains sessions for the app process. The main process reuses one randomly named in-memory partition per task and installs its permission/download handlers once. Each mounted panel still has a fresh view ID. Before allowing navigation on reopen, the session's site data, HTTP cache, authentication cache, and connections are cleared. Repeated opens therefore reuse a session; opening previews in new tasks still allocates new sessions until the app exits.

Electron recommends alternatives to `<webview>`, and an iframe would impose embedding and cross-origin DOM restrictions. `WebContentsView` provides the needed control, at the cost of explicit placement, visibility, and cleanup. See [Electron's embedding guide](https://www.electronjs.org/docs/latest/tutorial/web-embeds) and [native view resource management](https://www.electronjs.org/docs/latest/api/base-window#resource-management).

## Verification

Focused tests cover URL and payload validation, IPC ownership, picker arming and cancellation, redirects, view disposal, draft preservation, native focus, drag visibility, shadow-root siblings, editable-text privacy, and persistence:

```sh
npx vitest run electron/shared/browser.test.ts electron/ipc/browser.test.ts electron/browser-preload.test.ts electron/preload-allowlist.test.ts src/lib/canvas-tabs.test.ts src/store/persistence.test.ts src/store/autosave.test.ts
npx vitest run --config vitest.client.config.ts src/components/TaskBrowserPanel.client.test.tsx src/components/TaskCanvasPanel.client.test.tsx src/store/canvas.client.test.tsx
```

For a native smoke check on macOS/Linux, use a local page with a button, link, and form field. Verify navigation/back/reload, hover/click/Escape picking, draft preservation, tab switching, dialogs, resizing/zoom, failed loads and recovery, and cleanup when the tab or window closes. DOM-only test environments cannot render a native `WebContentsView`.

Also open/close a task's preview at least 15 times: its session should be reused without `MaxListenersExceededWarning`. Set a cookie in one task and confirm another task cannot see it. Reopen the original task's preview and confirm cookies and local storage are empty.
