# Security

Remoter is a developer alpha for explicitly enrolled computers. No external security audit has been completed.

## Trust boundaries

- Importing an invitation trusts its exact host certificate and bearer token. Exchange invitations through a trusted private channel. They are credentials, not public device IDs.
- The controller validates TLS chains using the paired certificate, verifies its exact fingerprint, and requires TLS 1.3 for the inner host connection. Endpoint names may change without weakening certificate pinning.
- All host API routes require bearer authentication. Input is additionally gated by the host's explicit `--allow-input` option. Capture and request sizes are bounded.
- The relay forwards opaque TLS bytes. Its access token controls tunnel use, while a different host access token controls desktop access. A compromised relay can disrupt traffic and observe connection metadata but should not decrypt host traffic or impersonate the pinned host.
- SOCKS5 failures stop the request. Remoter does not silently fall back to direct connections. Destination DNS is passed to the proxy; resolving the proxy server's own name may use local DNS.
- The Electron renderer has no Node integration and uses a narrow, validated preload bridge. It receives frame images and device metadata, not stored host tokens. Host invitation copy is an explicit sharing action.
- Controller storage uses OS-protected encryption and refuses plaintext credential persistence. This is not protection against malicious software already running as the same user.
- Native host state uses owner-restricted filesystem access, including Windows ACL handling. Host invitations printed at startup must not go to shared log collectors.

## Revocation and lifecycle

Stop the host to immediately stop access. Restart with `--rotate-token` to invalidate existing invitations, and distribute a new invitation only to authorized controllers. Removing a device from a controller does not revoke copies of its invitation. Existing authorized controllers are indistinguishable to the alpha host; per-operator identity and independent audit logging are roadmap work.

Closing the desktop stops its child host. Hosts launched separately keep running until their process is stopped. No stealth installation, persistence, firewall exceptions, or elevated service is installed automatically.

The separate, explicitly invoked LAN update-host setup installs a visible `Remoter LAN Updates` scheduled task and a LocalSubnet-scoped firewall rule on port 17846. It serves publisher-signed installers, not remote desktop sessions. Updates use an embedded Ed25519 public key and signed installer size/SHA-256 checks; installation requires a user action after sessions stop. Private publisher keys remain outside the project and its shared copy. See [update trust and deployment](docs/updates.md).

## Reporting vulnerabilities

Do not post invitations, tokens, private keys, or sensitive screen captures in public issues. Once the repository is published, use GitHub private vulnerability reporting if enabled. Until a private reporting channel is configured, contact the repository owner privately before sharing exploit details. Never claim a vulnerability is fixed without a regression test and a verified affected-version assessment.
