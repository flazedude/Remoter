# Remoter Engine protocol v1

The alpha protocol is HTTP/1.1 over TLS 1.3, including when transported through an opaque WebSocket relay. Routes use `Authorization: Bearer <host-token>`, except the explicitly enabled LAN bootstrap described below. No route redirects are followed. A host identity is its pinned certificate, not its IP address or relay device name.

## Invitation

Base64url-encoded UTF-8 JSON:

```json
{
  "version": 1,
  "name": "Example computer",
  "endpoint": "https://192.168.1.50:45780",
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "token": "<32 random bytes encoded as base64url>",
  "relay": { "url": "wss://relay.example.com/v1/tunnel", "deviceId": "example-device", "token": "<relay access token>" }
}
```

`relay` is optional. This is a secret-bearing pairing capability, not a public enrollment identifier. Replacing a device certificate requires importing a new invitation. A token rotation invalidates previous invitations.

## API

| Route | Result |
| --- | --- |
| `GET /v1/health` | Authenticated health response |
| `GET /v1/info` | Host name, OS, protocol/application version, capture/input capabilities, display geometry |
| `GET /v1/frame?display=0&quality=65&width=1280` | One JPEG frame, bounded dimensions and quality |
| `POST /v1/input` | One validated input event; requires host input permission |
| `GET /v1/lan-pair` | Easy-LAN invitation; host opt-in and direct attached private-subnet peer required |
| `GET /v1/clipboard` | JSON `{ "text": "..." }`; requires host clipboard permission |
| `POST /v1/clipboard` | Sets UTF-8 text, at most 1 MiB, without NUL; same permission |
| `GET /v1/audio?after=0` | Next bounded PCM packet, or an empty packet after one second of silence; requires host audio permission |

`info.capabilities` additionally exposes `clipboard` and `audio` booleans. Older hosts may omit them; controllers treat absent values as unavailable. Audio packets contain `{sequence, data, sampleRate: 48000, channels: 2}`. `data` is base64 interleaved stereo signed 16-bit little-endian PCM, normally 50 ms per packet. Send the returned sequence as `after` on the next request. A bounded ring discards old audio when a listener falls behind. Capture starts on demand and stops after three idle seconds; host shutdown stops it immediately. Audio and clipboard use the same pinned transport over direct, Tailscale and relay routes.

## LAN discovery and bootstrap

An explicitly discoverable host listens for IPv4 UDP on port 45781, joining multicast group `239.255.77.82` on active interfaces. Controllers send `{service: "remoter-discover-v1", nonce: "<32 hex characters>"}` using multicast and per-interface subnet broadcast, with one retry. Replies contain `{service: "remoter-host-v1", nonce, name, endpoint, certificate, easy}` and no token. Controllers validate the certificate and reply nonce, and reject endpoints whose IP differs from the reply source.

When `--easy-lan` is enabled, `GET /v1/lan-pair` returns `{invitation}` over certificate-pinned TLS without a prior token. Only native requests from loopback or attached private/link-local subnets can bootstrap. Relay requests are explicitly excluded regardless of relay address; browser Origin headers are rejected. This is deliberate trust in peers on the local LAN during initial discovery. Saved devices retain their certificate pin. The issued token is random per host process and accepted only from direct LAN peers; it cannot authenticate a relay request. Normal invitation tokens retain their existing behavior. Disabling easy access on restart revokes LAN tokens without revoking private invitations.

Input events are `move` with `displayId,x,y` in display-relative native pixels; `button` with `button,down`; `key` with browser physical `code,down`; `scroll` with bounded `deltaX,deltaY`; or `releaseAll`. Display coordinates must be computed from the displayed image rectangle, excluding letterboxing. The client must release held keys/buttons on blur, disconnect, and loss of control permission.

Frames are requested sequentially. A slow network must reduce delivered frame rate instead of accumulating unbounded captures. The first implementation intentionally favors inspectable behavior over codec complexity.

The desktop targets 30 FPS for LAN, Balanced, and Sharper image, and 15 FPS for Less bandwidth. LAN requests quality 90 and the display's native width up to 3840 pixels. Automatic LAN selection applies to direct private/local endpoints without SOCKS5; other routes start Balanced. These are targets, not guaranteed throughput. Received FPS is displayed in the session footer.

## Routes

Direct and Tailscale routes use the paired host endpoint. Tailscale is an existing network interface, not an alternate identity system. SOCKS5 wraps the selected TCP route, preserving destination hostnames for remote DNS. There is no direct retry after a proxy failure.

Relay sessions carry the same inner pinned TLS bytes over WebSocket. A separately authenticated host connection waits for a viewer connection at the relay, and the relay bridges binary messages. Outer WSS certificates use normal trusted CA verification. Unencrypted outer WS is restricted to loopback development.

The alpha does not perform NAT hole punching, centralized authorization, or automatic route selection. These must preserve the same authenticated-host boundary when introduced.
