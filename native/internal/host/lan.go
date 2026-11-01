package host

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"strings"

	"golang.org/x/net/ipv4"
)

const DiscoveryGroup = "239.255.77.82:45781"

// LAN access is restricted to peers on an attached private subnet. Forwarded
// headers and relay addresses never establish LAN membership.
func localPeer(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	if !ip.IsPrivate() && !ip.IsLinkLocalUnicast() {
		return false
	}
	addresses, _ := net.InterfaceAddrs()
	for _, address := range addresses {
		if network, ok := address.(*net.IPNet); ok && network.Contains(ip) {
			return true
		}
	}
	return false
}

func NewLANToken() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}

// Discovery advertises public identity only. Pairing credentials are retrieved
// over pinned HTTPS, and only when easy LAN access was enabled by the host.
func StartDiscovery(name, endpoint, certificate string, easy bool, port int) (func(), error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: port})
	if err != nil {
		return nil, err
	}
	packet := ipv4.NewPacketConn(conn)
	group, _ := net.ResolveUDPAddr("udp4", DiscoveryGroup)
	interfaces, _ := net.Interfaces()
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp != 0 && iface.Flags&net.FlagMulticast != 0 {
			_ = packet.JoinGroup(&iface, group)
		}
	}
	go func() {
		buf := make([]byte, 512)
		var replies limiter
		for {
			n, peer, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if !localPeer(peer.String()) {
				continue
			}
			var query struct {
				Service string `json:"service"`
				Nonce   string `json:"nonce"`
			}
			if json.Unmarshal(buf[:n], &query) != nil || query.Service != "remoter-discover-v1" || len(query.Nonce) != 32 || strings.Trim(query.Nonce, "0123456789abcdef") != "" {
				continue
			}
			if !replies.allow(100) {
				continue
			}
			response, _ := json.Marshal(map[string]any{"service": "remoter-host-v1", "nonce": query.Nonce, "name": name, "endpoint": endpoint, "certificate": certificate, "easy": easy})
			_, _ = conn.WriteToUDP(response, peer)
		}
	}()
	return func() { _ = conn.Close() }, nil
}
