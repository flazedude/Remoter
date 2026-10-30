# Contributing to Remoter

Use small, reviewable changes. Explain the user-visible behavior and how it was verified. Run TypeScript checks, engine tests, Go tests, and the production build before proposing changes. Capture/input changes also need relevant real-device checks.

Do not copy code from other remote desktop engines without reviewing its license and recording attribution. Study public designs and documentation; write Remoter's implementation independently. Prefer established cryptographic libraries and operating-system primitives.

Never commit host state, invitation tokens, screenshots of private desktops, private keys, proxy credentials, generated binaries, or signing material. Synthetic capture is available for tests. Never run input-injection tests against a developer's active desktop.

Security-sensitive changes must account for every transport, especially relay and proxy failure behavior. Keep platform-specific code behind the platform boundary. Unsupported capabilities must return a clear error rather than a simulated success.

Contributions are licensed under Apache-2.0. By submitting a change, you represent that you have the right to contribute it under that license.
