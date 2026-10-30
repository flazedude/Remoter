package relay

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/net/proxy"
)

type HostConfig struct {
	URL       string
	DeviceID  string
	Token     string
	TLSConfig *tls.Config
	Handler   http.Handler
	PoolSize  int
	OnError   func(error)
	// ProxyURL routes every outbound relay connection via SOCKS5 with remote DNS.
	ProxyURL string
}

func ParseProxyURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "socks5" && u.Scheme != "socks5h") || u.Hostname() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("proxy must be a socks5:// or socks5h:// host:port URL")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("proxy requires a valid port")
	}
	if u.User != nil {
		password, _ := u.User.Password()
		if len(u.User.Username()) < 1 || len(u.User.Username()) > 255 || len(password) > 255 {
			return nil, errors.New("invalid SOCKS5 credentials")
		}
	}
	return u, nil
}

func relayHTTPClient(proxyURL string) (*http.Client, error) {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	dial := dialer.DialContext
	if proxyURL != "" {
		u, err := ParseProxyURL(proxyURL)
		if err != nil {
			return nil, err
		}
		var auth *proxy.Auth
		if u.User != nil {
			password, _ := u.User.Password()
			auth = &proxy.Auth{User: u.User.Username(), Password: password}
		}
		socks, err := proxy.SOCKS5("tcp", u.Host, auth, dialer)
		if err != nil {
			return nil, errors.New("could not configure SOCKS5 proxy")
		}
		contextDialer, ok := socks.(proxy.ContextDialer)
		if !ok {
			return nil, errors.New("SOCKS5 transport does not support cancellation")
		}
		// SOCKS5 receives the hostname directly; there is no local destination lookup
		// and no direct retry when the proxy rejects or becomes unavailable.
		dial = contextDialer.DialContext
	}
	transport := &http.Transport{Proxy: nil, DialContext: dial, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 10 * time.Second, DisableKeepAlives: true, ForceAttemptHTTP2: false}
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}

func ValidateURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/" && u.Path != "/v1/tunnel") {
		return nil, errors.New("invalid relay URL")
	}
	ip := net.ParseIP(u.Hostname())
	loopback := strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && ip.IsLoopback())
	if u.Scheme != "wss" && !(u.Scheme == "ws" && loopback) {
		return nil, errors.New("relay requires WSS; WS is only allowed on loopback for development")
	}
	u.Path = "/v1/tunnel"
	return u, nil
}

// ServeHost keeps a bounded pool of outbound reverse tunnels available. TLS
// terminates at the host using the same identity certificate as direct access.
func ServeHost(ctx context.Context, cfg HostConfig) error {
	u, err := ValidateURL(cfg.URL)
	if err != nil {
		return err
	}
	if !validDevice.MatchString(cfg.DeviceID) || !validToken.MatchString(cfg.Token) || cfg.Handler == nil || cfg.TLSConfig == nil || len(cfg.TLSConfig.Certificates) == 0 {
		return errors.New("reverse relay requires device ID, host token, TLS identity, and handler")
	}
	if cfg.ProxyURL != "" {
		p, err := ParseProxyURL(cfg.ProxyURL)
		if err != nil {
			return err
		}
		if u.Scheme == "ws" {
			ip := net.ParseIP(p.Hostname())
			if !strings.EqualFold(p.Hostname(), "localhost") && (ip == nil || !ip.IsLoopback()) {
				return errors.New("plain development WS cannot use a non-loopback proxy; configure WSS")
			}
		}
	}
	if cfg.PoolSize == 0 {
		cfg.PoolSize = 4
	}
	if cfg.PoolSize < 1 || cfg.PoolSize > 8 {
		return errors.New("relay pool must contain 1 to 8 connections")
	}
	query := u.Query()
	query.Set("role", "host")
	query.Set("device", cfg.DeviceID)
	u.RawQuery = query.Encode()
	var workers sync.WaitGroup
	for i := 0; i < cfg.PoolSize; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			backoff := time.Second
			for ctx.Err() == nil {
				started := time.Now()
				err := serveHostTunnel(ctx, u.String(), cfg)
				if ctx.Err() != nil {
					return
				}
				if err != nil && cfg.OnError != nil {
					cfg.OnError(errors.New("relay tunnel unavailable; retrying"))
				}
				if time.Since(started) > 10*time.Second {
					backoff = time.Second
				} else {
					backoff = min(backoff*2, 30*time.Second)
				}
				timer := time.NewTimer(backoff)
				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()
					return
				}
			}
		}()
	}
	workers.Wait()
	return ctx.Err()
}

func serveHostTunnel(ctx context.Context, endpoint string, cfg HostConfig) error {
	client, err := relayHTTPClient(cfg.ProxyURL)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, _, err := websocket.Dial(dialCtx, endpoint, &websocket.DialOptions{
		HTTPHeader:      http.Header{"Authorization": {"Bearer " + cfg.Token}},
		CompressionMode: websocket.CompressionDisabled,
		HTTPClient:      client,
	})
	cancel()
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	transport := newBufferedConn(websocket.NetConn(ctx, conn, websocket.MessageBinary))
	defer transport.Close()
	tlsCfg := cfg.TLSConfig.Clone()
	tlsCfg.MinVersion = tls.VersionTLS13
	tlsCfg.NextProtos = []string{"http/1.1"}
	secure := tls.Server(transport, tlsCfg)
	handshakeCtx, stopHandshake := context.WithTimeout(ctx, 2*time.Minute)
	err = secure.HandshakeContext(handshakeCtx)
	stopHandshake()
	if err != nil {
		return err
	}
	listener := &oneConnListener{conn: secure, done: make(chan struct{})}
	server := &http.Server{
		Handler:           cfg.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
		WriteTimeout:      15 * time.Second,
		MaxHeaderBytes:    8192,
		ConnState: func(_ net.Conn, state http.ConnState) {
			if state == http.StateClosed || state == http.StateHijacked {
				_ = listener.Close()
			}
		},
	}
	defer server.Close()
	stop := context.AfterFunc(ctx, func() { _ = server.Close(); _ = listener.Close() })
	defer stop()
	err = server.Serve(listener)
	if errors.Is(err, net.ErrClosed) || errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

type oneConnListener struct {
	conn     net.Conn
	mu       sync.Mutex
	accepted bool
	done     chan struct{}
	once     sync.Once
}

func (l *oneConnListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if !l.accepted {
		l.accepted = true
		l.mu.Unlock()
		return l.conn, nil
	}
	l.mu.Unlock()
	<-l.done
	return nil, net.ErrClosed
}
func (l *oneConnListener) Close() error   { l.once.Do(func() { close(l.done) }); return nil }
func (l *oneConnListener) Addr() net.Addr { return l.conn.LocalAddr() }
