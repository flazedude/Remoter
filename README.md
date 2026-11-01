# Remoter

**Your computers. Your connection. Your engine.**

Remoter is an open-source remote desktop application for Windows and macOS, powered by the independently implemented **Remoter Engine**. It is not a RustDesk, VNC, or RDP fork. It uses established TLS, operating-system APIs, and small open-source libraries rather than inventing cryptography.

This repository is an early developer alpha. The first implementation uses bounded JPEG screen frames over pinned TLS 1.3, with authenticated keyboard and mouse events. Hardware video encoding, a boot-time service, secure-desktop elevation, and enterprise identity are subsequent milestones. Do not mistake the alpha for an audited production remote-administration product.

## Components

| Component | Location | Purpose |
| --- | --- | --- |
| Desktop | `apps/desktop` | Electron + React controller, device directory, sharing, sessions, network settings, activity |
| Engine client | `packages/engine` | Certificate-pinned TLS, pairing, SOCKS5 routing, frame/input protocol, relay transport |
| Native host | `native/cmd/remoter-host` | Go host with screen capture and native Windows/macOS input |
| Relay | `native/cmd/remoter-relay` | Self-hosted opaque WebSocket tunnel for outbound connections |

The controller keeps pairing and proxy credentials in an OS-encrypted local store. Desktop sharing enables keyboard and mouse control by default; uncheck the option for view-only access. The standalone host CLI requires `--allow-input`. The desktop starts without sample devices, and browser preview cannot control computers.

## Develop

Prerequisites: Node.js 22 or newer, npm, and Go 1.26. macOS native builds require Xcode Command Line Tools and macOS 15 or newer for the capture implementation.

```sh
npm ci
npm run build:native
npm run dev
```

The Electron window is the functioning application. `npm run preview` opens only the UI development server at `http://127.0.0.1:5173`; native operations are explicitly unavailable there.

### Connect two computers

1. Build or install Remoter on both machines.
2. On the computer being controlled, open **Share this computer**. Choose a listen address and the reachable HTTPS address to put in the invitation. Keyboard and mouse control is enabled by default; uncheck it for view-only sharing.
3. For one-click LAN access, enable **Show this PC in LAN discovery** and **Easy LAN connections**, then start sharing. Easy LAN access is off by default; enabling it lets anyone on an attached private LAN connect while sharing runs.
4. On the controller, choose **Add device** and select **Add & connect** beside the nearby PC. Or copy the host's invitation through a private channel, paste it in **Add device**, then connect.
5. Stop sharing to close access. For automatic startup on a Windows target, enable **Launch on boot** after starting sharing. Remoter starts in the tray after Windows sign-in with the saved address and permissions. Closing its window keeps it running when this option is on; choose **Quit Remoter** in the tray to exit. **Stop sharing** also clears automatic sharing until you start sharing again.

Sessions start controlling once the first frame arrives when the host allows input, using the normal mouse pointer. Escape switches to view-only; losing focus releases held keys and buttons. **Options**, **Updates**, **Devices**, and **Activity** sit beside Remoter in the Windows title bar. Options and Updates remain accessible during sessions; disconnect before changing the connection route. Updates can install during a session and restore it after restarting.

LAN discovery uses UDP port **45781** on the same network; desktop connections still use the host's HTTPS port (normally **45780**). Allow those ports for your private LAN if the firewall blocks them. Discovery sends public identity metadata; credentials are fetched over pinned HTTPS. Easy LAN credentials expire each time sharing stops, and saved LAN devices obtain fresh credentials on reconnect. LAN discovery and easy access require Direct mode with SOCKS5 off. Hosts with easy access off still appear, but require an invitation. A changed IP can be refreshed by scanning and selecting the same host again.

On a Windows host, enable **Allow two-way text clipboard** and/or **Allow system audio** before starting sharing. During a session, use the clipboard icon to sync newly copied text in both directions, or its **Send clipboard to host** / **Get host clipboard** buttons for an immediate transfer. Ctrl/Cmd+V sends the local text before the remote paste when sync is on. Text is limited to 1 MiB; files, images, and clipboard history are not transferred. The speaker icon plays the host's default system output on the controller; it does not forward a microphone. Both session options start off and remain unavailable when the host denies them. System audio and clipboard hosting currently require Windows; the desktop controller can receive them on other platforms.

Direct connections to private LAN addresses default to **LAN · Smooth**, targeting 30 FPS at up to 1920 pixels wide and JPEG quality 80. Sustained slow frames reduce width to 1600, 1280, then 960; sustained headroom restores it gradually. **Original · Max quality** keeps the previous 4K/quality-90 option. Balanced and Sharper image also target 30 FPS; Less bandwidth targets 15 FPS. The host overlaps one capture with encoding/transfer and never builds an unbounded frame queue. Windows scales during capture, and other platforms use an optimized RGBA scaler. The footer shows received FPS and requested stream width. Actual FPS depends on capture, encoding, display, and network throughput; transport still uses JPEG rather than hardware video encoding.

The desktop suggests a local private interface for sharing, falling back to loopback if none is available. Review Connection details before starting. The standalone CLI defaults to loopback. For a LAN, an example is listen `192.168.1.50:45780` and advertised address `https://192.168.1.50:45780`. Restrict the host firewall to the networks you intend to allow. For Tailscale, advertise the host's Tailscale IP or fully qualified MagicDNS name, and allow the port in your tailnet policy. The application does not install or administer Tailscale.

An invitation contains an access credential. Anyone who receives it can connect while the host is running, subject to host permissions. It is not a short-lived enrollment link. Removing a device from one controller does not revoke a copied invitation; rotate the host token to do that. See [Security](SECURITY.md).

### Run a host directly

```sh
# Windows executable names end in .exe.
./native/bin/remoter-host --listen 127.0.0.1:45780 --advertise https://127.0.0.1:45780

# Input is disabled unless explicitly requested.
./native/bin/remoter-host --listen 0.0.0.0:45780 --advertise https://192.168.1.50:45780 --allow-input

# Opt in to discovery, easy LAN access, clipboard and system audio.
./native/bin/remoter-host --listen 192.168.1.50:45780 --discover --easy-lan --allow-input --allow-clipboard --allow-audio

# Test transport without capturing a real screen or injecting real input.
./native/bin/remoter-host --synthetic --listen 127.0.0.1:45780
```

The process writes a JSON readiness message containing the invitation to stdout. Treat that output as a secret. A state directory stores the host identity and token; use a separate `--state-dir` for isolated test hosts.

## Networking

- **Direct:** connect to the paired host's HTTPS endpoint on a LAN, routed network, or explicitly reachable internet address.
- **Tailscale:** use a paired tailnet endpoint with the installed Tailscale client. Application pairing and TLS verification still apply.
- **SOCKS5:** an explicit TCP proxy route, with destination DNS resolved by the proxy. Connection failure never retries outside the proxy. This is application routing, not a system-wide proxy setting.
- **Relay:** both sides connect outbound to your WebSocket relay. The host TLS connection is carried inside the tunnel; the relay does not decrypt frames, input, or the host access token. See [Relay deployment](docs/relay.md).

There is no automatic NAT hole punching or route racing in this alpha. Choose direct or relay explicitly. A TCP relay favors predictable proxy/firewall behavior over video performance. Plain SOCKS5 password authentication is not encrypted by SOCKS5 itself; use a trusted/protected path to the proxy.

## Verification and packaging

```sh
npm run typecheck
npm test
npm run test:native
npm run build
npm run test:integration
npm run test:desktop
npm run package
```

`package` creates an unpacked app for the current platform. `npm run dist` builds a Windows setup wizard and portable application, or a macOS disk image, in `release/`. On Windows, run `Remoter-Setup-<version>-x64.exe` to install the app with shortcuts and an uninstaller; the wizard defaults to installing for the current user and lets you choose the installation folder. Use `Remoter-Portable-<version>-x64.exe` to run without installing. Signing and macOS notarization require the publisher's credentials and are not configured by this repository. Build on the target OS; the CI workflow includes Windows and macOS native builds and tests.

## Current boundaries

- The host operates in the current logged-in user session. It does not install a boot service, bypass Windows UAC, or unlock FileVault preboot.
- macOS needs Screen Recording and Accessibility approval. Native macOS behavior must be verified on Mac hardware.
- JPEG polling is the first transport baseline, not a high-frame-rate video codec.
- Pairing is per device, with a revocable device token. Central accounts, MFA, per-operator capabilities, short-lived grants, and fleet policies are planned.
- Concurrent controllers of one host share input state; use one controlling session per host during the alpha.
- Activity history belongs to the local controller; it is not an independent security audit trail.
- Windows x64 releases support signed updates from LAN mirrors and GitHub, with user-triggered installation. See [updates and LAN setup](docs/updates.md). macOS updates are not implemented.
- No file transfer, microphone forwarding, session recording, or fleet jobs yet. Clipboard and system audio hosting are Windows-only.

See [Roadmap](ROADMAP.md), [protocol](docs/protocol.md), and [contributing](CONTRIBUTING.md).

## License

Apache License 2.0. Copyright 2026 Remoter contributors. Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
