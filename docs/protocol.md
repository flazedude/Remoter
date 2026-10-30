# Remoter Engine protocol v1

The alpha protocol is HTTP/1.1 over TLS 1.3, including when transported through an opaque WebSocket relay. All routes use `Authorization: Bearer <host-token>`. No route redirects are followed. A host identity is its pinned certificate, not its IP address or relay device name.

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

Input events are `move` with `displayId,x,y` in display-relative native pixels; `button` with `button,down`; `key` with browser physical `code,down`; `scroll` with bounded `deltaX,deltaY`; or `releaseAll`. Display coordinates must be computed from the displayed image rectangle, excluding letterboxing. The client must release held keys/buttons on blur, disconnect, and loss of control permission.

Frames are requested sequentially. A slow network must reduce delivered frame rate instead of accumulating unbounded captures. The first implementation intentionally favors inspectable behavior over codec complexity.

## Routes

Direct and Tailscale routes use the paired host endpoint. Tailscale is an existing network interface, not an alternate identity system. SOCKS5 wraps the selected TCP route, preserving destination hostnames for remote DNS. There is no direct retry after a proxy failure.

Relay sessions carry the same inner pinned TLS bytes over WebSocket. A separately authenticated host connection waits for a viewer connection at the relay, and the relay bridges binary messages. Outer WSS certificates use normal trusted CA verification. Unencrypted outer WS is restricted to loopback development.

The alpha does not perform NAT hole punching, centralized authorization, or automatic route selection. These must preserve the same authenticated-host boundary when introduced.
