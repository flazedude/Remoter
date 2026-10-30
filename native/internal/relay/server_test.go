package relay

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const hostSecret = "host_0123456789012345678901234567890123456789"
const viewerSecret = "view_0123456789012345678901234567890123456789"

func testRelay(t *testing.T, waiting int) (*Server, string) {
	t.Helper()
	service, err := NewServer(Config{Devices: map[string]DeviceCredentials{"device1": {HostToken: hostSecret, ViewerToken: viewerSecret}}, MaxWaiting: waiting, WaitTimeout: 3 * time.Second, IdleTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service)
	t.Cleanup(func() { service.Close(); server.Close() })
	return service, "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/tunnel"
}

func dialTest(ctx context.Context, endpoint, role, token string) (*websocket.Conn, *http.Response, error) {
	return websocket.Dial(ctx, endpoint+"?device=device1&role="+role, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
}

func TestRelayRoleAuthorizationAndOpaqueBridge(t *testing.T) {
	_, endpoint := testRelay(t, 2)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, role := range []string{"host", "viewer"} {
		_, response, err := dialTest(ctx, endpoint, role, "invalid")
		if err == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatal("unauthenticated connection was accepted")
		}
	}
	_, response, err := dialTest(ctx, endpoint, "host", viewerSecret)
	if err == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatal("viewer token impersonated host")
	}
	host, _, err := dialTest(ctx, endpoint, "host", hostSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer host.CloseNow()
	var viewer *websocket.Conn
	for i := 0; i < 30; i++ {
		viewer, _, err = dialTest(ctx, endpoint, "viewer", viewerSecret)
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.CloseNow()
	secretBytes := []byte{0, 1, 255, 32, 17, 5}
	if err := viewer.Write(ctx, websocket.MessageBinary, secretBytes); err != nil {
		t.Fatal(err)
	}
	typ, received, err := host.Read(ctx)
	if err != nil || typ != websocket.MessageBinary || string(received) != string(secretBytes) {
		t.Fatalf("forward failed: %v", err)
	}
	if err := host.Write(ctx, websocket.MessageBinary, []byte("response")); err != nil {
		t.Fatal(err)
	}
	_, received, err = viewer.Read(ctx)
	if err != nil || string(received) != "response" {
		t.Fatalf("reverse failed: %v", err)
	}
}

func TestRelayDeniesOriginsAndBoundsWaitingPool(t *testing.T) {
	service, endpoint := testRelay(t, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, response, err := websocket.Dial(ctx, endpoint+"?device=device1&role=host", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + hostSecret}, "Origin": {"https://attacker.example"}}})
	if err == nil || response.StatusCode != http.StatusForbidden {
		t.Fatal("browser Origin was accepted")
	}
	host, _, err := dialTest(ctx, endpoint, "host", hostSecret)
	if err != nil {
		t.Fatal(err)
	}
	defer host.CloseNow()
	for i := 0; i < 30; i++ {
		service.mu.Lock()
		ready := len(service.devices["device1"].waiting) == 1
		service.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(time.Millisecond)
	}
	_, response, err = dialTest(ctx, endpoint, "host", hostSecret)
	if err == nil || response.StatusCode != http.StatusTooManyRequests {
		t.Fatal("waiting pool was not bounded")
	}
}

func testIdentity(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Remoter test host"}, DNSNames: []string{"remoter.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	cert, err := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	return cert, pool
}

func TestReverseHostEndToEndTLS(t *testing.T) {
	_, endpoint := testRelay(t, 4)
	cert, roots := testIdentity(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		finished <- ServeHost(ctx, HostConfig{URL: endpoint, DeviceID: "device1", Token: hostSecret, PoolSize: 2, TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}}, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer inside-secret" {
				http.Error(w, "denied", http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte("inner TLS reached host"))
		})})
	}()
	var conn *websocket.Conn
	var err error
	for i := 0; i < 100; i++ {
		conn, _, err = dialTest(ctx, endpoint, "viewer", viewerSecret)
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	transport := websocket.NetConn(ctx, conn, websocket.MessageBinary)
	secure := tls.Client(transport, &tls.Config{RootCAs: roots, ServerName: "remoter.test", MinVersion: tls.VersionTLS13})
	defer secure.Close()
	if err := secure.HandshakeContext(ctx); err != nil {
		t.Fatalf("inner TLS handshake failed: %v", err)
	}
	reader := bufio.NewReader(secure)
	for i := 0; i < 3; i++ {
		_, err = fmt.Fprint(secure, "GET /v1/info HTTP/1.1\r\nHost: remoter.test\r\nAuthorization: Bearer inside-secret\r\n\r\n")
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.ReadResponse(reader, nil)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || string(body) != "inner TLS reached host" {
			t.Fatalf("unexpected host response: %s %v", body, err)
		}
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("host relay workers failed to stop")
	}
}

func TestRelayConfigAndURLValidation(t *testing.T) {
	if _, err := NewServer(Config{Devices: map[string]DeviceCredentials{"bad": {HostToken: hostSecret, ViewerToken: hostSecret}}}); err == nil {
		t.Fatal("shared role token accepted")
	}
	for _, raw := range []string{"ws://public.example", "wss://user:pass@example.com", "wss://example.com?token=secret", "https://example.com"} {
		if _, err := ValidateURL(raw); err == nil {
			t.Fatalf("unsafe URL accepted: %s", raw)
		}
	}
	for _, raw := range []string{"ws://127.0.0.1:8788", "ws://[::1]:8788", "wss://relay.example.com"} {
		if _, err := ValidateURL(raw); err != nil {
			t.Fatal(err)
		}
	}
}

func TestHostSOCKSRemoteDNSAuthenticationAndNoFallback(t *testing.T) {
	var requests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); _, _ = w.Write([]byte("proxied")) }))
	defer target.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	observed := make(chan string, 1)
	proxyDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			proxyDone <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		var header [2]byte
		if _, err = io.ReadFull(conn, header[:]); err != nil {
			proxyDone <- err
			return
		}
		methods := make([]byte, int(header[1]))
		if _, err = io.ReadFull(conn, methods); err != nil {
			proxyDone <- err
			return
		}
		_, _ = conn.Write([]byte{5, 2})
		if _, err = io.ReadFull(conn, header[:]); err != nil {
			proxyDone <- err
			return
		}
		username := make([]byte, int(header[1]))
		if _, err = io.ReadFull(conn, username); err != nil {
			proxyDone <- err
			return
		}
		var length [1]byte
		if _, err = io.ReadFull(conn, length[:]); err != nil {
			proxyDone <- err
			return
		}
		password := make([]byte, int(length[0]))
		if _, err = io.ReadFull(conn, password); err != nil {
			proxyDone <- err
			return
		}
		if string(username) != "operator" || string(password) != "test-secret" {
			proxyDone <- fmt.Errorf("wrong proxy authentication")
			return
		}
		_, _ = conn.Write([]byte{1, 0})
		var connect [4]byte
		if _, err = io.ReadFull(conn, connect[:]); err != nil {
			proxyDone <- err
			return
		}
		if connect[3] != 3 {
			proxyDone <- fmt.Errorf("destination was resolved locally")
			return
		}
		if _, err = io.ReadFull(conn, length[:]); err != nil {
			proxyDone <- err
			return
		}
		hostname := make([]byte, int(length[0]))
		if _, err = io.ReadFull(conn, hostname); err != nil {
			proxyDone <- err
			return
		}
		observed <- string(hostname)
		if _, err = io.ReadFull(conn, header[:]); err != nil {
			proxyDone <- err
			return
		}
		upstream, err := net.Dial("tcp", target.Listener.Addr().String())
		if err != nil {
			proxyDone <- err
			return
		}
		defer upstream.Close()
		_, _ = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
		go func() { _, _ = io.Copy(upstream, conn) }()
		_, err = io.Copy(conn, upstream)
		proxyDone <- err
	}()
	proxyAddress := listener.Addr().String()
	client, err := relayHTTPClient("socks5h://operator:test-secret@" + proxyAddress)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://remote-dns.invalid/v1/test")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(body) != "proxied" {
		t.Fatal("proxy did not reach destination")
	}
	if name := <-observed; name != "remote-dns.invalid" {
		t.Fatalf("unexpected destination: %s", name)
	}
	_ = listener.Close()
	if _, err := client.Get(target.URL); err == nil {
		t.Fatal("unavailable proxy fell back to direct")
	}
	if requests.Load() != 1 {
		t.Fatal("direct endpoint received an unauthorized fallback")
	}
	if err := <-proxyDone; err != nil {
		t.Fatal(err)
	}
}
