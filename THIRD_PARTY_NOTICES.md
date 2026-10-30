# Third-party components

Remoter's original source is Apache-2.0. It uses these independently licensed foundations; it does not include a RustDesk, MeshCentral, VNC, or RDP engine fork.

| Component | License | Role |
| --- | --- | --- |
| Go standard library | BSD-3-Clause | TLS, HTTP, JPEG, process and filesystem primitives |
| Electron | MIT (bundles Chromium/Node and additional notices) | Desktop runtime |
| React | MIT | Interface |
| Lucide | ISC | Interface icons |
| kbinani/screenshot | MIT | Windows screen capture; macOS uses Remoter's own ScreenCaptureKit adapter |
| golang.org/x/sys | BSD-3-Clause | Operating-system interfaces |
| golang.org/x/net | BSD-3-Clause | Host-side SOCKS5 transport |
| coder/websocket | ISC | Relay tunnel framing |
| ws | MIT | Client WebSocket transport |
| socks | MIT | SOCKS5 connection negotiation |

Exact dependency versions are recorded in `package-lock.json` and `native/go.sum`. Distributed applications must retain their bundled dependency notices. This list summarizes direct runtime components; it does not replace transitive license files or Electron's bundled notices.
