# Deploying the Remoter relay

The alpha relay pairs two outbound WebSocket connections and forwards their
binary bytes. It never decrypts the inner TLS 1.3 connection between controller
and host. The controller still checks the exact host certificate from its
invitation and the host still verifies its separate pairing token.

This is a manually configured pilot relay. It has no public registration,
database, account login, high availability, or automatic regional selection.
Each device has two independent relay secrets: one for its host role and one for
viewers. A viewer secret cannot register a replacement host. Possessing a relay
viewer secret alone does not grant desktop access; the host invitation is also
required.

## Local test

Build from the repository root:

```powershell
Set-Location native
go build -o bin/remoter-relay.exe ./cmd/remoter-relay
```

From the `native` directory, generate secrets with `../deployment/new-relay-secrets.ps1 -DeviceId office-pc`.
The command prints sensitive JSON; keep it out of shared logs. Assign that JSON
to the relay process's `REMOTER_RELAY_DEVICES` environment variable, then run:

```powershell
.\bin\remoter-relay.exe -listen 127.0.0.1:8788
```

The required JSON shape is:

```json
{
  "office-pc": {
    "hostToken": "REPLACE_WITH_RANDOM_HOST_TOKEN",
    "viewerToken": "REPLACE_WITH_DIFFERENT_RANDOM_VIEWER_TOKEN"
  }
}
```

The placeholders above are deliberately invalid. Tokens must contain 32–256
base64url characters; the generator uses 32 random bytes. Device IDs use 1–80
letters, digits, hyphens or underscores. Use distinct tokens for every device and
role. Restart the relay after changing its configuration. Restarting it closes
existing tunnels, which also makes token rotation effective for active sessions.

Configure the host's environment before starting `remoter-host`:

```powershell
$env:REMOTER_RELAY_URL = 'ws://127.0.0.1:8788'
$env:REMOTER_RELAY_DEVICE = 'office-pc'
$env:REMOTER_RELAY_TOKEN = '<hostToken for office-pc>'
$env:REMOTER_RELAY_VIEWER_TOKEN = '<viewerToken for office-pc>'
.\bin\remoter-host.exe --synthetic
```

The viewer token is optional on the host. When present it is included in the
host's private invitation, allowing the controller to select Relay without
retyping credentials. When absent, configure the relay URL, device ID and viewer
token in the controller. The invitation endpoint still identifies the host's
direct address; relay mode does not need to reach that address.

Plain `ws://` is accepted only for loopback development. A configured SOCKS5
proxy for that mode must also be loopback. For different machines use `wss://`
with a valid public or locally trusted certificate.

## Public WSS deployment with Caddy

On a Linux server with Docker Compose, point a DNS hostname you control at the
server. Allow inbound TCP 80 and 443 for Caddy and certificate issuance. Hosts
and controllers need only outbound TCP 443 to this relay; no incoming desktop
port or router forwarding is needed on those devices.

From `deployment/`:

1. Copy `.env.example` to `.env` and supply the real hostname and generated
   per-device credentials. Protect this file; Docker administrators can inspect
   container environment variables.
2. Copy `Caddyfile.example` to `Caddyfile`.
3. Run `docker compose -f compose.example.yml up -d --build`.
4. Use `wss://relay.your-domain.example` on each endpoint.

The relay shares Caddy's network namespace and listens on `127.0.0.1:8788`.
Only Caddy exposes ports. Caddy verifies no Remoter identities itself; it
terminates outer WSS while the inner TLS session remains encrypted through it.
The configuration deliberately does not enable HTTP access logging.

The Docker recipe is provided for deployment review; it must be built and tested
on the intended server before use. The repository's automated protocol tests run
the relay locally, not a real public TLS deployment. Pin container image digests
in a maintained production deployment and keep Caddy and Go security updates
current.

An alternative is standalone TLS:

```text
remoter-relay -listen 0.0.0.0:443 -tls-cert /path/fullchain.pem -tls-key /path/key.pem
```

The relay refuses a non-loopback plaintext listener. Its `/healthz` endpoint
returns only `ok`; room/device listings are not exposed. Native connections to
`/v1/tunnel?role=host|viewer&device=...` carry their relay token in the
Authorization header, never the URL. Browser Origin headers are rejected.

## SOCKS5 on either endpoint

The controller's network profile can route its direct or relay connection through
SOCKS5 with optional credentials. Destination DNS goes through the proxy and a
proxy failure never retries directly. The Tailscale route cannot be combined with
that proxy setting, because the separate Tailscale service owns its network path.

For a host behind a proxy, set this additional variable before starting it:

```powershell
$env:REMOTER_RELAY_PROXY_URL = 'socks5h://username:password@proxy.example:1080'
```

Both `socks5://` and `socks5h://` use remote destination DNS here. Percent-encode
special characters in credentials. This routes the host's outbound reverse relay
connections only; it does not change other apps or the direct host listener.
There is no direct fallback. A hostname for the proxy itself is resolved locally.
Standard SOCKS5 username/password authentication is not encrypted on the
client-to-proxy hop; use a trusted local/private proxy or protect that hop. Inner
desktop TLS and public WSS do not encrypt the preceding SOCKS authentication.

## Limits and observable behavior

Defaults currently compiled into the relay:

| Limit | Default |
| --- | --- |
| Open relay WebSockets across all devices | 512 |
| Waiting host sockets per device | 8 |
| Active viewer tunnels per device | 8 |
| Authenticated upgrade attempts per device | 240 per minute |
| Waiting host lifetime | 90 seconds |
| Paired tunnel lifetime | 1 hour |
| Inactivity in either stream direction | 60 seconds |
| Bytes in either stream direction per tunnel | 4 GiB |
| Maximum incoming WebSocket message | 1 MiB |

The host maintains four outbound tunnel workers, reconnecting with a bounded
backoff. A worker serving an active HTTP connection is not available to another
viewer until that connection closes. The desktop client uses at most four HTTP
sockets. These are transport connection limits, not guarantees of eight desktop
sessions. When all host workers are occupied or the host is offline, new viewers
receive an availability error. An unused host socket rotates after 90 seconds;
an abrupt network loss can leave a stale waiting entry until that timeout, so an
initial connection may need a retry.

The relay caps resources and authenticates upgrades, but deployment-level rate
limiting, monitoring, alerting and DDoS protection remain operator work. A relay
sees device IDs, IP addresses, timing and byte volume. It cannot see the desktop,
input events or the inner host bearer token. It does not record sessions.

The relay test suite verifies role separation, quotas, Origin rejection, opaque
bidirectional transport, a real inner TLS handshake, and host-side SOCKS5 remote
DNS/authentication with no direct fallback. The Node engine tests independently
verify certificate pinning, controller-side SOCKS5 and inner TLS through a relay.

After `npm run build:native`, `npm run test:integration` starts isolated synthetic
Go hosts and the actual Go relay, then uses the TypeScript engine to verify device
information, JPEG frames, simulated input and release over both direct and relay
routes. It uses random local credentials, keeps state under ignored
`test-results/`, and stops only the child processes it starts. No real desktop is
captured or controlled. The relay check uses an unreachable direct endpoint to
ensure it cannot accidentally pass through a direct connection.
