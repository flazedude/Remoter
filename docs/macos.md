# Remoter on macOS

The Mac app uses the existing Electron desktop and Go host. Native hosting
requires macOS 15 or newer. Build on the target architecture; the current local
build is Apple Silicon (arm64). Intel builds need their own native host and
Electron runtime; the arm64 package is not universal.

## Build and run

Install Node.js 22+, npm, Go 1.26+, and Xcode Command Line Tools, then run:

```sh
npm ci
npm run build:native
npm run dev
```

`npm run package` creates `release/mac-arm64/Remoter.app` on Apple Silicon
(`release/mac/Remoter.app` on Intel). `npm run dist` also creates a disk image.
The native build explicitly targets macOS 15, including runtime/cgo, rather
than inheriting the build computer's newer OS minimum.

## Share this Mac

1. Open **Set up sharing** and review **Mac permissions**.
2. Choose **Open Screen Recording settings**. Allow Remoter in System Settings
   → Privacy & Security → Screen Recording (called Screen & System Audio
   Recording on some versions).
3. For remote keyboard and mouse control, also choose **Open Accessibility
   settings** and enable Remoter. Leave control off for view-only sharing.
4. Quit and reopen Remoter after changing permissions. Choose **Check
   permissions again**, then start sharing and use the invitation or LAN
   discovery from another computer.

Permission status comes from the same native helper used for hosting, without
capturing pixels or injecting input. Starting a real host checks that helper's
permissions before opening a listener. Setup buttons request only the selected
permission and open a fixed System Settings pane. They do not grant access;
macOS requires the user's approval. Merely opening Remoter or connecting to
another computer does not request these host permissions.

During unbundled development, macOS may attribute permission to the launching
terminal or `remoter-host`. Installed builds should use a stable signing
identity. Developer ID signing and notarization require publisher credentials
and remain unconfigured; this iteration's local package is a development build.
Moving or rebuilding an unsigned app/helper may require approving access again.

Clipboard and system audio **hosting**, launch on boot, and in-app updates
remain Windows-only. The Mac controller can receive clipboard/audio when a
Windows host permits them. Closing the Mac app stops sharing.

## Verification

```sh
npm run typecheck
npm test
npm run test:native
npm run build:native
npm run build
npm run test:integration
npm run test:desktop
npm run package
npm run test:package
```

The integration and desktop tests use generated frames and simulated input.
The package smoke check launches the bundled app with an isolated profile,
checks the native helper and permission UI, rejects unsupported permission
actions, and verifies denied permissions prevent sharing where applicable. It
does not request permission, capture the real desktop, or inject real input.

For a read-only native permission check without creating host state or opening
a listener:

```sh
./native/bin/remoter-host --check-permissions
```

Real capture/input, Retina and mixed-DPI displays, sleep/resume, lock/login,
permission changes, and Windows ↔ Mac sessions still need interactive device
validation. Never run automated input injection against an active desktop.
