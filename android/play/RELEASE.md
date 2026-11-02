# Google Play production release

Package: `com.parallelcode.phone`. Public policy: <https://parallelcode.app/android-privacy/>.
The policy source bundled in the app is `app/src/main/assets/privacy.html`. Keep the
website's `pc-landing-page/public/android-privacy/index.html` identical when updating it.

## Current submission status (2026-10-24)

- Signed `0.2.0 (60)` is available in internal testing and submitted for production review.
- Four emulator screenshots are included in the submitted Play listing.
- The public Android privacy policy was deployed and verified byte-for-byte against
  `app/src/main/assets/privacy.html`.
- The foreground-service declaration is saved with this review video:
  <https://parallelcode.app/android-privacy/foreground-service-review.mp4>.
  It records the actual service on an Android 14 emulator using the debug build
  and a loopback WebSocket fixture. The fixture sends a labelled needs-input event;
  no live AI agent runs. Android diagnostics confirmed `isForeground=true` while
  enabled and no service after disabling. The recording explicitly labels these
  limitations. This does not replace testing the exact Play build on a physical device.
- The policy and video are preserved in the sibling landing-page repository under
  `public/android-privacy/`. Both were deployed and verified before submission.
- The user confirmed AI editing of the artwork. The icon and feature graphic are
  labelled AI-edited; the four unedited app screenshots are not.
- Submitted all 11 changes, including production `0.2.0 (60)`, on 2026-10-24.
  Automated pre-checks completed and Play Console confirmed the changes are being
  reviewed. Managed publishing is off; the requested
  full rollout can publish after approval. The only release validation warning
  was missing native debug symbols; there were no blocking errors.

The historical open items below predate these updates.

## Build and promote

1. Run `./gradlew testDebugUnitTest assembleDebug lintRelease bundleRelease` with the Android SDK installed.
2. After the reviewed changes reach `main`, run the Android workflow with `version_name`
   set to the public version (for example `0.2.0`). The workflow retains its run-number
   version-code sequence and uploads the signed AAB to internal testing.
3. Install that exact Play build and test pairing, terminal/chat replies, task creation,
   notifications, backups, and the privacy policy before pairing and in Settings → About.
4. Verify the merged release manifest has no `ACCESS_BACKGROUND_LOCATION` or `AD_ID`.
5. With Wait for VPN enabled and VPN off: home Wi-Fi can bypass the wait while the
   app is visible; leaving the app must clear that exception. With VPN active or
   Wait for VPN disabled, background notifications should still work. Denying
   foreground location must not prevent other app features.
6. Complete Play Console app-content declarations, reviewer access, store assets,
   pricing/countries, and production access. Promote the tested bundle to production
   and submit for review. Submission is not publication; verify approval and rollout.

Promote before the next `android/` push to `main`: that push publishes a newer
internal build over the release candidate (it remains in the app bundle explorer).
Confirm that "The Front End" in the privacy policy matches the Play developer name.

Do not promote an older internal bundle containing background location. Do not
create a new signing key: use the existing upload key and Play App Signing.
Production does not publish automatically on every push.

## Store listing (English)

Name: Parallel Code

Short description: Monitor coding agents on your computer and respond from your phone.

Full description:

Parallel Code is the Android companion for Parallel Code on macOS and Linux.
Keep up with your coding agents, review their progress, and respond when they need you.

• See which agents are working, need input, or have changes ready to review.
• Read terminal output and built-in chats, send replies, and answer agent questions.
• Review code changes and task notes, and start new tasks on your computer.
• Receive optional notifications when agents need input, encounter an error, or finish.
• Keep several computers linked and switch between them.
• Customize themes, quick replies, and a home-screen widget.
• Back up settings and saved connections to a location you choose.

Requires the Parallel Code desktop app and a reachable connection to your computer.
Coding agents run on your computer; the phone app does not include an AI subscription
or hosted coding service. Connect over your trusted local network, an encrypted VPN,
or an HTTPS endpoint you configure. Scan the Connect Phone QR code or paste its link,
then pair with the desktop to enable replies and task actions.

Optional foreground location access identifies your home Wi-Fi so the app can skip
waiting for a VPN while it is open. No background location is requested. For
background notifications, connect your VPN or turn off Wait for VPN.

Website: https://parallelcode.app
Support: contact@super-productivity.com
Category: Productivity
Ads: No
Government app: No
Financial features: None
Health features: None
Advertising ID: No (verify merged manifest for each release).

## Release notes (this release)

Home Wi-Fi now skips Wait for VPN only while the app is open; the app no longer asks
for background location. For agent notifications at home, connect your VPN or turn
off Wait for VPN.

## Declarations requiring care

Do not answer Data safety with an unconditional "no data collected":
Google's scanner SDK collects diagnostics, usage events, and device/installation
identifiers. See https://developers.google.com/ml-kit/android-data-disclosure.
Prompts, terminal commands, notes and task actions leave the phone for the chosen
desktop, and user-selected cloud backup providers may receive backup contents.
Ordinary HTTP connections are supported, so do not claim all data is encrypted in transit.
Wi-Fi names remain local. Android speech recognition is delegated to the user's
recognizer; audio is not recorded by this app. Review applicable user-initiated
sharing exemptions against https://support.google.com/googleplay/android-developer/answer/10787469.

Foreground service justification: the user explicitly enables agent notifications
in Settings. A persistent notification identifies the running service. It maintains
a live connection to the user's own desktop to deliver time-sensitive input requests,
errors and task completion notifications. Turning agent notifications off stops it.
Provide a real device demonstration video showing enabling, ongoing notification,
background event delivery and disabling. Do not submit an invented video URL.

Reviewer access must be reusable and exercise the desktop-dependent functionality.
Never publish a developer's personal desktop tokens or expose a working development
machine for review. Use an isolated demo environment or a clearly labeled demo mode.

## Reviewer access (App access instructions)

These instructions apply to the broader offline demo. They do
not describe the current internal Play candidate `0.2.0 (56)` at `c0df1d19`, which
contains the earlier, limited demo. Build, upload and install the broader demo before
submitting these instructions or attesting that reviewers can access all features.
No login, personal token, desktop installation, pairing code from a real computer,
or special network is needed. Everyone can enter the same demo:

1. On **Connect to your computer**, tap **Try demo — no computer needed**. If already
   connected, open **Settings** and tap **Try offline demo**. A persistent
   **Demo · offline samples** banner offers **Reset** and **Exit demo** on every screen.
2. Open **Review the welcome screen**. Allow or decline its sample test approval,
   answer the greeting question and send a chat reply. Quick replies, message history
   and the microphone button work locally; the microphone inserts sample dictation
   without recording audio. Open **Interrupt a working chat** to try **Stop**.
3. Open **Explore terminal, notes and changes**. Read and scroll terminal output,
   type a reply, try quick keys, expand the terminal and inspect the **Notes** and
   **Changes** tabs. Edit and save a note. **Merge** opens readiness checks and its
   squash/cleanup options. **Close** offers a warning before discarding sample changes.
4. Open **Fix a sample CI failure**, tap **Fix CI**, edit the sample failure prompt
   and send it. Its sample check changes to passed; no CI workflow runs.
5. Tap **New task**. Pick a sample project, chat or terminal agent and optional model,
   enter a prompt and create the task. The new sample supports the same controls.
   Search, filters, task swiping and the minimized-task setting use the normal UI.
6. Switch sample computers from the task-list computer menu or **Settings**. Rename
   or forget a sample computer. **Add computer** opens offline setup; add a sample
   computer and enter **123456** to try the normal pairing form, or continue viewing
   only and pair later. No supplied address or token belongs to a real desktop.
7. In **Settings**, try themes, quick replies and terminal options. Notification,
   screen-awake, VPN/Wi-Fi and widget settings are explicitly local simulations.
   Widget color/opacity swatches preview appearance. In **Backups**, create a
   session-only backup with or without a password, change settings and restore it.
   The real backup format and encryption operate only on sample credentials,
   settings and history held in memory. Scheduling and update checks are simulated.
   **About** opens the bundled privacy policy without a network connection.
8. **Reset** restores every sample, including settings and saved sample computers.
   **Exit demo** resumes the user's original settings and computers. Re-entering
   starts a fresh sample session.

The demo uses the normal task/chat/terminal/settings screens with an in-memory
session instead of the desktop transport. Entering it pauses real desktop sockets,
polls, notification watching and update checks; demo data never reaches real prompt
history, preferences, backups, widgets or notification services. All terminal input,
Git actions, agent replies and pairing are simulations: no commands, paid agents or
AI calls run. The demo requests no device permissions.

Actual QR scanning or external connection links, Android speech recognition,
home-screen widget placement, external backup-provider selection and scheduling,
update installation, VPN/Wi-Fi integration and background notification delivery
require the real device smoke checks above. The demo is not evidence that a
foreground service actually ran. The foreground-service declaration still needs a
real-device video. Confirm that this disclosed simulation is sufficient for Play's
full-access attestation; do not tick it merely because demo instructions can be entered.

## Open release items

- Install the exact Play build on a real device, run the smoke checks and record
  the foreground-service video. Upload the phone screenshots; the icon and feature
  graphic were uploaded to Play Console on 2026-10-24.
- Android run `40017824793` failed because `LookPalettes.kt` was stale. Regenerating
  it locally fixes the failure; Android unit tests, debug assembly, release lint
  and bundle generation passed on 2026-10-24, as did `npm run check`. The fix still
  needs to reach `main` before creating the signed Play candidate.
- Signed `0.2.0 (56)` at `c0df1d19` is in **internal testing only** and contains the
  earlier, limited demo. The expanded offline demo needs a new signed build that is
  installed and tested before the reviewer instructions above can be submitted.
  Play's full-feature-access attestation remains unresolved.
- Play App access completion gates target-audience and location declarations;
  target audience then gates Data safety submission.
- Play app pricing is **Free**. Production countries are unset; the planned
  submission selects all available countries.
- Google replied to support case **8-3703000041808**: it does not provide
  pre-compliance checks or questionnaire selections, and recommends IARC for
  classification edge cases. The user authorized proceeding with submission
  using an honest assessment rather than waiting for IARC. The questionnaire is
  still incomplete; the user authorized accepting IARC's terms. Google's
  help excludes user-imported material, but the form explicitly includes AI output.
  See the
  [official content-rating guidance](https://support.google.com/googleplay/android-developer/answer/11070055).
- The Data safety draft includes messages, other user content, app interactions,
  diagnostics, and identifiers, without a universal encryption claim. Keep it in
  step with the bundled and website privacy policies.
