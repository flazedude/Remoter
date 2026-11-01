# Remoter roadmap

## 0.1 — Native connection baseline

- Own Go host, TypeScript client, and minimal desktop UI.
- Explicit pairing, pinned TLS, view-only default, opt-in native input.
- Display selection and bounded JPEG capture with backpressure.
- Direct, Tailscale address, strict SOCKS5, and self-hosted opaque relay routes.
- LAN discovery and opt-in one-click LAN access; Windows text clipboard and system audio sharing.
- Windows local verification; macOS CI and physical-device verification tracked separately.

## 0.2 — Reliable unattended operation

- Real-device matrix: Windows/Mac in every direction; Retina, mixed DPI, headless, sleep/resume, network changes, and multiple keyboards.
- Windows service/session separation and audited UAC/secure-desktop handling.
- macOS permission onboarding, stable signing identity, and persistent capture evaluation.
- Visible tray/menu-bar status, session management, startup policy, and bounded disconnect recovery.
- Per-controller authorization, session ownership, token rotation UX, idle expiry, and host-side audit metadata.

## 0.3 — Performance and managed deployments

- Native capture optimizations and hardware video encoding behind existing protocol interfaces.
- Adaptive bitrate, dirty regions, cursor separation, congestion feedback, reconnect/resume.
- Automatic path selection and NAT traversal after explicit-route behavior is proven.
- Signed installers, authenticated updates, rollback/recovery, and rollout rings.
- File transfer and macOS clipboard/system audio hosting; richer clipboard formats.

## 0.4 — Fleet management

- Organization identity, MFA, enrollment invitations, groups, tags, and scoped roles.
- Agent-enforced short-lived capabilities on every route, revocation during sessions, and policy freshness requirements.
- Inventory and queued jobs with explicit targeting, cancellation, concurrency limits, idempotency, and per-device results.
- Staged agent updates and targeted reboots first; remote shell and input broadcast require separate designs.

Targets for the first internal pilot: 10–50 devices and 1–5 simultaneous sessions. Performance targets must be based on measurements on the intended hardware and networks.
