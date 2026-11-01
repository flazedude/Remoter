# Windows updates and LAN mirrors

Install `Remoter-Setup-<version>-x64.exe` once on each Windows PC. The **Updates** page checks all reachable sources and selects the newest publisher-signed alpha release:

| Source | Location |
| --- | --- |
| Jack PC | `http://192.168.2.76:17846/remoter/latest.json` |
| GPD PC | `http://192.168.2.59:17846/remoter/latest.json` |
| GitHub | Published releases of `flazedude/Remoter`, including alpha prereleases |

Checks run ten seconds after starting a packaged Windows x64 app, every thirty minutes, and when requested in Updates. Downloads happen in the background. A stale LAN feed cannot hide a newer reachable GitHub release. LAN downloads are preferred only when the signed version, size, SHA-256, and source commit match. If a matching mirror fails, another matching source is tried. Source failures remain visible when checking an otherwise current version.

Update transport currently uses direct LAN/HTTPS connections. Enabling the desktop's SOCKS5 setting pauses update requests and cancels an in-progress download, so updates do not silently bypass the proxy. Disable SOCKS5 explicitly to check updates directly.

The client verifies an Ed25519 signature against its embedded Remoter public key, then checks the installer's signed size and SHA-256 after download and again immediately before launching it. HTTP is accepted only for literal private/loopback IPv4 addresses, and LAN redirects cannot leave their origin or Remoter path. GitHub uses HTTPS and allowlisted download hosts. A manifest cannot supply an arbitrary installer path or command. Windows Authenticode signing is separate and is not configured yet; these release signatures authenticate updates after the initial trusted installation.

Once verified, choose **Install update** anytime, including while sharing or controlling a computer. No manual stop, disconnect, or closing of other programs is required. Remoter saves a one-use, OS-encrypted handoff, releases input, and exits cleanly. A hidden helper waits for that exact process to exit, runs setup silently in the existing install location, and automatically reopens Remoter. Sharing resumes with the same address and permissions, and the active controlling session reconnects. Connections pause during the restart; this is not a zero-downtime update. Pairing and settings remain in the OS-encrypted user-data store, outside the app directory.

The handoff expires after one hour and is consumed before restoration. Ordinary launches do not restart sharing; **Launch on boot** is a separate opt-in that restores saved sharing on a Windows sign-in launch. If setup fails, the helper attempts to reopen the previous executable with a failure message; if sharing or the remote host cannot be restored, Remoter reports that too. Portable builds use the same installer, which installs Remoter. macOS in-app updates are not implemented. Clients older than 0.1.0-alpha.4 retain their old update behavior for the one-time upgrade to this version.

## Set up each LAN host once

The Remoter mirror runs independently of HappyCheats. It uses **17846**, its own public key, scheduled task, firewall rule, and `%PROGRAMDATA%\RemoterUpdateServer` directory. HappyCheats stays on 17845. No desktop-sharing service is installed by this setup.

On Jack PC and GPD PC, open the distributed `LAN-Host-Setup` folder and double-click **Enable-LAN-Updates.cmd**. Approve Windows administrator access for your usual account. The launcher stages locally before elevation, so it also works from the network drive. It detects `.76` or `.59` on the local PC and refuses other hosts. It does not copy private signing keys. The launcher prints the local `result.json` path; inspect that result to confirm completion.

Setup installs the **Remoter LAN Updates** boot task as SYSTEM and an inbound firewall rule limited to this executable, the reserved host address, port 17846, and LocalSubnet. Only administrators/SYSTEM may replace the service executable or trust configuration. The task waits thirty seconds after boot, retries exited servers, and runs on battery. Mirror refresh happens on server startup and five minutes after each attempt. Valid installer downloads are staged and verified before atomically changing the public feed; existing installers are immutable. Failures keep the previous valid feed available. It may take an initial download before the feed appears.

Manual starter links, once a mirror is populated:

```text
http://192.168.2.76:17846/remoter/Remoter-Setup.exe
http://192.168.2.59:17846/remoter/Remoter-Setup.exe
```

Check `/health`, the signed feed, and an actual installer download from a second computer before claiming cross-PC access. Task health alone does not prove that a release was mirrored or that the firewall permits another PC. Remote administration is not assumed; run the setup on each host locally if it cannot be configured from the publishing PC.

## Publish a new version

The publishing identity is created once with `npx tsx scripts/init-update-key.ts`. Its private key is protected under `%LOCALAPPDATA%\RemoterPublisher\release-private.pem`, outside the repository and network copy. Back up that key securely. Preserve `updates/config.json` and the same signing identity; if the private key is missing on another publishing PC, restore it securely rather than creating a replacement. The public configuration belongs in source control and the LAN setup bundle.

1. Increase the root and desktop package versions and lockfile to a unique higher release version. Supported versions are `major.minor.patch` and `major.minor.patch-alpha.N`.
2. Add `docs/releases/<version>.md`, review changes, commit, and push them to shared GitHub `main`.
3. Run `npm run publish:release` on Windows. It checks types and tests, builds the native engine and Windows distributions, stages the LAN setup bundle, and runs integration/desktop checks before publishing.

The publisher uses the existing Git credential manager without putting credentials in files or arguments. It requires a clean source tree exactly matching GitHub main, signs the feed with its exact source commit, reserves an immutable version tag, uploads a draft's assets, verifies GitHub's reported SHA-256 and size for every asset, and only then publishes the alpha release. GitHub's source archives come from that tag. Mirroring hosts automatically pull the new signed release after publication. Check each host's feed to confirm activation.

An interrupted draft can be resumed with `npx tsx scripts/publish-update.ts` using the original untouched build outputs. Changed bytes require a higher version. A stale `release/.publish.lock` after an abruptly terminated process requires checking that no publisher is still running before removing that one lock. Do not overwrite a published version or delete old installers that clients might still be downloading.
