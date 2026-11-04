# Phone access

Follow your agents and answer them from a phone. On the desktop, **Connect Phone** shows a QR code and a connection link; the phone UI then works in any mobile browser on the same Wi-Fi or through [Tailscale](https://tailscale.com/). Terminal output and replies travel directly between your phone and your computer; push notifications carry only the task name and its ID.

## Android app

On Android, the native app adds agent notifications that need no HTTPS setup, a home-screen widget, and voice input.

1. On your phone, open the [Android releases](https://github.com/johannesjo/parallel-code/releases?q=android-v&expanded=true) and download the newest `parallel-code-phone-*.apk`.
2. Open the downloaded file. Android asks you to allow installs from your browser the first time.
3. In the app, scan the QR code from **Connect Phone** or paste its link, then enter the desktop PIN to enable replies.

The app is not in the Play Store yet. It checks GitHub for a newer release once a day and offers the download; you can turn that off under **Settings → About**. [Obtainium](https://github.com/ImranR98/Obtainium) can also install and update it: add `https://github.com/johannesjo/parallel-code` and filter release titles by `Android`.

Its notifications come from your computer over the same connection as the app, so the phone has to be able to reach your computer, on the same Wi-Fi or through Tailscale. Turning them on keeps a quiet notification visible while the app watches in the background.

## Phone notifications

Paired phones can receive a notification when a running task changes to **Needs input**, including while the phone is locked or the phone app is closed. Tap the notification to open that task. Parallel Code must remain running on your computer with phone access enabled, and both devices need internet access for push delivery.

1. Open the phone UI over **HTTPS**. The ordinary Wi-Fi and Tailscale IP links use HTTP and cannot enable browser push. One option is [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve): with both devices on your tailnet, run `tailscale serve --bg http://127.0.0.1:7777` on your computer (use the port shown in **Connect Phone**, normally `8777` in development). Follow Tailscale's HTTPS setup prompts.
2. Copy the connection link from **Connect Phone** and replace its `http://IP:PORT` part with the HTTPS address printed by Serve, keeping `?token=…`. Open that link on your phone and authorize it with the desktop PIN. Choose **Keep this device authenticated** to retain notifications across computer restarts.
3. On iPhone/iPad (iOS/iPadOS 16.4 or later), use **Add to Home Screen**, then open the app from that icon and authorize it there if asked. [Apple requires a Home Screen web app for Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
4. In **Your tasks → Task notifications**, tap **Enable notifications** and allow notifications when your phone asks. You can turn them off in the same place. Disconnecting phones on the desktop revokes their notifications too.

Notifications show the task name and a request for input; terminal output and connection credentials are not included. Opening a task still requires a connection to your computer. A different HTTPS proxy can also be used at the origin root; it must preserve the original `Host` header and forward WebSockets.
