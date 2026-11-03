# Remoter native host

This is an explicitly started desktop host. The initial build supports the current logged-in desktop; it does not install a boot service, handle Windows secure-desktop/UAC elevation, unlock FileVault, or configure macOS privacy permissions.

Requirements: Go 1.26; Windows 64-bit, or macOS 15+ with Xcode Command Line Tools and CGO enabled. Windows capture uses the MIT-licensed `github.com/kbinani/screenshot` OS capture helper. The macOS capture adapter calls ScreenCaptureKit directly, and input uses CoreGraphics/Accessibility. The protocol, authorization, transport, and input handling are our own implementation.

```powershell
go build -o bin/remoter-host.exe ./cmd/remoter-host
go test ./...
go vet ./...
```

macOS build (run on macOS 15 or newer):

```sh
CGO_ENABLED=1 go build -o bin/remoter-host ./cmd/remoter-host
CGO_ENABLED=1 go test ./...
```

The macOS adapter embeds these cgo compiler flags: `-x objective-c -fblocks -mmacosx-version-min=15.0`. It links ScreenCaptureKit, CoreGraphics, Foundation, and ApplicationServices. `npm run build:native` also sets the deployment target for runtime/cgo and linking. Screen Recording and Accessibility permissions must be granted to the appropriate installed app/helper identity before real control. The unbundled development binary may be attributed to the launching terminal. The native host, synthetic transport, and packaged app have been built and tested on an Apple Silicon Mac. Real capture/input, signing, lock/login behavior, and Retina/multiple-display behavior still need interactive validation. See [Mac setup](../docs/macos.md).

`--check-permissions` reports native capture/input permissions as JSON and exits without creating an identity, opening a listener, capturing a frame, or injecting input. The desktop setup actions use `--request-permission screen` or `--request-permission input` only after a local user action; macOS still requires approval.

By default the host is view-only, binds `127.0.0.1:45780`, and stores its identity under the user's configuration directory. Use `--listen 0.0.0.0:45780 --advertise https://YOUR-LAN-OR-TAILNET-IP:45780` for an explicitly reachable endpoint. Add `--allow-input` to permit keyboard/mouse events; OS privilege boundaries still apply. `--rotate-token` invalidates old invitation bearer tokens on restart. Invitations contain the access token and pinned public certificate, and must be shared privately. Private key/token files receive owner-only POSIX permissions or an owner/SYSTEM-only Windows ACL.

The desktop app launches with `--exit-on-stdin-close` and an open stdin pipe. Closing that pipe shuts down gracefully and releases input held by Remoter. Do not force-kill the host during input unless graceful shutdown has failed. The host also releases held inputs after five seconds without input activity. Sessions currently share one host token and input state; simultaneous independent controllers on the same host are not an isolated multi-user feature.

Endpoints require the bearer token and TLS 1.3, except the opt-in easy LAN bootstrap. `/v1/info` describes capabilities and logical display coordinate dimensions; `/v1/frame` returns a bounded JPEG; `/v1/input` validates pointer, key, button and scroll events. Frames are limited to 30 requests/second and one capture at a time; input is limited to 240 requests/second. `releaseAll` bypasses that limit. Maximum frame request width is 3840 and JPEG quality is 20–90. Input coordinates are relative to the selected display; the Mac uses logical display units. Browser-origin requests are rejected.

`--discover` advertises public identity on UDP 45781 (multicast and subnet broadcast). `--easy-lan` additionally permits direct private-subnet peers to fetch a process-scoped invitation over pinned HTTPS at `/v1/lan-pair`. It deliberately allows anyone on the attached private LAN to connect without an invitation, is disabled by default, and never applies to relay traffic. Stopping the host revokes easy LAN credentials. `--allow-clipboard` enables two-way Unicode text at `/v1/clipboard` (1 MiB maximum). `--allow-audio` enables on-demand Windows WASAPI playback loopback at `/v1/audio`; no microphone is captured. Real clipboard/audio hosting currently requires Windows. Synthetic hosts provide an in-memory clipboard and silence packets for transport tests without touching either OS resource.

Reverse relay configuration is supplied by environment: `REMOTER_RELAY_URL`, `REMOTER_RELAY_DEVICE`, `REMOTER_RELAY_TOKEN` (host-role token), optional `REMOTER_RELAY_VIEWER_TOKEN` to include viewer relay details in the invitation, and optional `REMOTER_RELAY_PROXY_URL` (`socks5://username:password@proxy:1080`) for proxy-only outbound relay traffic. The host and viewer relay tokens must be different. Proxy credentials belong in environment/configuration, not command-line arguments or logs. Proxied relay dialing resolves destination names through SOCKS5 and never falls back to direct dialing.

Ordinary tests only use generated frames and simulated input. `--synthetic` provides that same safe backend for end-to-end tests. An optional Windows capture check reads one live frame into memory, reports only dimensions/encoded byte count, saves no image, and injects no input:

```powershell
$env:REMOTER_TEST_REAL_CAPTURE='1'
try { go test ./internal/platform -run TestOptInRealWindowsCapture -count=1 -v }
finally { Remove-Item Env:\REMOTER_TEST_REAL_CAPTURE }
```
