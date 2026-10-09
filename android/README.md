# Parallel Code for Android

Native companion app for the desktop's **Connect Phone** (Remote Access) feature. It talks to the same HTTP/WebSocket API as the phone web UI in `src/remote/`.

## What it does

- **Connect:** scan the QR code in Connect Phone, or paste the link under it. This gives a view-only token.
- **Pair:** enter the six-digit code from Connect Phone to get a paired token, which may type into terminals. "Keep this phone authorized" asks the desktop to remember the phone across restarts.
- **Several computers:** link more than one desktop (for example the installed app and a dev build, or two machines) and switch between them in Settings → Computers; each keeps its own pairing.
- **Agents:** live list with each agent's status and last line, grouped as in the phone web UI (Needs you, Working, Ready to review, Other tasks). Search by task, project, or agent name, and narrow it with the All / Needs you / Review chips. The list sits under the desktop's Claude, Codex, and Antigravity 5-hour and weekly usage meters (hidden on desktops without `/api/mobile/usage`).
- **Minimized tasks:** tasks minimized on the desktop are pinned below the live list; a setting hides them.
- **Looks:** the same 15 themes as the desktop, in Settings → Appearance. Follow system / always dark / always light picks the tone, and a separate dark and light look is remembered, so switching your phone's theme switches the look with it. Each look is drawn with a live swatch, and every color and corner radius comes from the desktop's own stylesheet. See [Looks](#looks).
- **Settings:** theme and looks, keep the screen on, widget background transparency and card color, connection status, wait for VPN (skipped on your home Wi-Fi, which needs location access to read the network name, and "Allow all the time" for agent notifications in the background), and forget this computer.
- **Swipe between tasks:** with a task open, swipe sideways to the previous or next one in the list; the header shows its position ("2 of 5"). When another task needs you, **Next task →** at the bottom of the terminal jumps straight to it.
- **Terminal:** an agent's terminal in the colors of the look you picked, matching the desktop. Once paired: a reply box and keys a phone keyboard lacks (Enter, Esc, Tab, arrows, Ctrl+C). As on the desktop, typing `!` into an empty reply switches to the agent's shell mode; tap the `!` to leave it. With "Fit the terminal to this phone" on (Settings, off by default), the terminal takes the phone's size while open so full-screen agents such as Claude Code fill it; the computer's own terminal shifts meanwhile and gets its size back when you leave.
- **Terminal space and zoom:** pinch with two fingers to magnify the whole terminal up to 400%, and pan with two fingers (or sideways with one) to read a part of it; one finger still scrolls the history. Swiping between tasks pauses while zoomed; double-tap or the zoom pill resets it. The expand icon in the title bar hides the title, tabs, and quick keys while keeping the message field and Send/Stop available; the restore icon or Android Back returns to the normal layout without losing your draft. Terminal and chat replies use full-width multiline fields, with action buttons below.
- **History:** opening a terminal loads the desktop's history (up to 10,000 lines), and the phone keeps up to 20,000 lines while the terminal stays open.
- **Changes:** the task's diff against its base branch, file by file with added and removed lines.
- **Quick replies and voice:** saved replies above the built-in chat's reply box (edit them in Settings; the terminal leaves them out to make room) and a mic button that dictates with Android's speech recognizer.
- **Widget:** a home-screen widget with the agents that need you and the usage meters, updated while the app is connected. Settings → Widget sets its background transparency (opaque, 75%, 50% or 25%; the border fades with the card, so your wallpaper shows through) and its card color (Obsidian, Slate or Light, each with text colors that stay readable).
- **Notes:** read a task's notes panel; edit and save it once paired.
- **New task:** pick a project and describe the work; needs pairing.
- **Notifications:** optional, in Settings. A foreground service keeps the connection open in the background and notifies when an agent needs input, hits an error, or finishes (each can be turned off); tapping one opens that agent.
- **Close task:** from an agent's screen; needs pairing. Like the desktop, it warns before losing uncommitted or unmerged work.

- **Built-in chat:** read the conversation, send messages, stop the agent, and answer its approvals and questions once paired. Choosing the model and attaching images stay on the computer.

## Looks

The phone uses the desktop's look presets, not its own. `LookPalettes.kt` is generated from the files the desktop already keeps its looks in:

| Desktop source     | What it contributes                                          |
| ------------------ | ------------------------------------------------------------ |
| `src/lib/look.ts`  | Preset ids, labels, descriptions, order, and light/dark tone |
| `src/styles.css`   | The colors and the corner radius scale                       |
| `src/lib/theme.ts` | The terminal ANSI palettes and which look pairs with which   |

```sh
npm run generate:android-looks   # rewrite LookPalettes.kt after a desktop theme change
npm run check:android-looks      # fail if it is out of date (also run by the Kotlin tests)
```

Three things are worth knowing about the mapping:

- **The cascade is resolved, not copied.** Each desktop theme sets only the variables it changes and inherits the rest from `:root`, so the generator resolves the full palette per preset. The phone has no fallback values of its own.
- **Gradients are flattened.** Several desktop backgrounds are `radial-gradient`s. The phone draws flat surfaces, so a gradient becomes its middle stop, which keeps the look recognizable. Everything else is the exact value.
- **Terminals follow the look.** A terminal is drawn over the look's `--task-panel-bg` with the ANSI set the desktop pairs with that look, so Midnight gets a pure-black panel and Noir gets Noir's ANSI colors. Dark looks with no set of their own on the desktop fall back to the muted Noir set, because the desktop's fallback there is xterm's own defaults.

Obsidian in both tones is the default, and its values are pinned by `LookPalettesTest`, so adding a theme cannot quietly change what the app looks like out of the box.

## Build

Needs JDK 17+ and the Android SDK (compile SDK 37). Set `ANDROID_HOME` or add `sdk.dir` to `android/local.properties`.

```sh
cd android
./gradlew testDebugUnitTest   # unit tests
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug        # install on a connected device
```

### Google Play test builds

The Android workflow tests pull requests and pushes that change Android code or its shared theme sources. After tests pass on `main`, it builds a signed Android App Bundle and publishes it to Google Play's **internal testing** track. **Actions → Android → Run workflow** on `main` also publishes a test build. PRs, other branches, and release tags do not publish to Play.

One-time setup:

1. Create the Play Console app for `com.parallelcode.phone`, enroll in Play App Signing, and upload an initial signed bundle manually. Complete the required app setup and roll out the initial internal release so the app can accept `completed` releases via the API.
2. Register the certificate for the existing CI signing key as the Play upload certificate. CI reuses the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` repository secrets. For seamless updates between GitHub and Play installs, configure Play App Signing to use the existing app signing key too; the upload key alone does not determine the key on installed Play builds.
3. Enable the Google Play Android Developer API, create a service account, and invite its email in Play Console **Users and permissions**. Give it access to this app and permission to view app information and release to testing tracks. Store its JSON key as the GitHub Actions repository secret `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
4. Add testers under **Testing → Internal testing → Testers** and share the opt-in link. Testers install and update through Google Play.

CI uses the Android workflow run number as `versionCode` and `internal.<run>` as `versionName`. The initial manual upload must use a lower version code than the next CI run. After a successful upload, start a **new workflow run** for another upload; rerunning the same run reuses its version code, which Play rejects. Keep this workflow's version-code sequence for future Play releases as well.

Publishing fails with a clear error if a required secret is missing. Signing builds do not restore Gradle caches, publishing jobs are serialized, and older runs skip publishing if a newer run has already published successfully. The check uses Android workflow runs rather than the latest main commit, so unrelated desktop changes do not suppress a test build. The temporary signing key is removed even on failure. See the [upload action setup](https://github.com/r0adkll/upload-google-play#configure-access-via-service-account) and [Android bundle publishing guide](https://developer.android.com/studio/publish/upload-bundle).

### Releases

`.github/workflows/android.yml` tests and builds the app whenever `android/` changes. Pushing a tag such as `android-v0.2.0` also publishes a signed APK as a GitHub release, kept separate from the desktop's `v*` releases. Signing reads `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` from the environment; CI fills them from repository secrets of the same names, with the keystore stored base64-encoded as `ANDROID_KEYSTORE_BASE64`. Every update must be signed with the same key, so keep a backup of it.

The release title starts with `Android`, which Obtainium filters on, and the APK name must keep ending in `.apk`: the app's update check (`AppReleases.kt`) looks for `android-v*` releases that are not drafts or prereleases and have an APK attached, and compares their dot-separated version numbers with its own `versionName`. Installs from an app store skip the check. User install steps are in the main [README](../README.md#android-app).

QR scanning uses the Google Play services code scanner, so the app needs no camera permission. On phones without Play services, paste the link instead.

## How it maps to the server

See `electron/remote/server.ts` and `electron/remote/protocol.ts`.

| Step         | Request                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Pair         | `POST /api/pair/verify` with `Authorization: Bearer <token>` and `{ pin, remember }`; returns `{ token }`                     |
| Connect      | WebSocket `/ws`; first message `{ type: "auth", token }`. The paired token is used when present                               |
| Watch        | `subscribe` / `unsubscribe`; the server sends `scrollback`, then `output` (base64 PTY bytes)                                  |
| View size    | `view-size` with `{ cols, rows }` (paired) while a terminal is open; without them, or on disconnect, the desktop size returns |
| Projects     | `GET /api/mobile/projects` (paired)                                                                                           |
| New task     | `POST /api/mobile/tasks` with `{ projectId, name, prompt }` (paired); returns `{ taskId }`                                    |
| Usage        | `GET /api/mobile/usage`; the desktop status bar's snapshot, readable view-only                                                |
| Notes        | `GET` / `PUT /api/mobile/notes/<taskId>` with `{ notes }`; reading works view-only, saving needs pairing                      |
| Close task   | `POST /api/mobile/tasks/<taskId>/close` with `{ force }` (paired); `409` with `{ warnings }` when work would be lost          |
| Changes      | `GET /api/mobile/tasks/<taskId>/diff` → `{ diff, truncated, unsupported }`; readable view-only                                |
| Reply        | `input` with `submit: true` and a `requestId`; confirmed by `input-result`                                                    |
| Close `4001` | Paired token rejected: drop it and reconnect view-only. QR token rejected: scan again                                         |
| Close `4003` | Typing rights lost: drop the paired token                                                                                     |
| HTTP 401     | On a paired-token request: drop the paired token and reconnect view-only                                                      |

Remote Access serves plain HTTP on the LAN or Tailscale address, so the app allows cleartext traffic. Credentials live in app-private storage and are excluded from backups and device transfer.
