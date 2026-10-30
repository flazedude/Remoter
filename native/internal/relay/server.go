// Package relay bridges encrypted streams without terminating the host's TLS.
package relay

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

var validDevice = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
var validToken = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)

// DeviceCredentials are separate role-scoped secrets. A viewer cannot register
// a replacement host, and a host token cannot open a viewing connection.
type DeviceCredentials struct {
	HostToken   string `json:"hostToken"`
	ViewerToken string `json:"viewerToken"`
}

type Config struct {
	Devices        map[string]DeviceCredentials
	MaxConnections int
	MaxWaiting     int
	MaxActive      int
	WaitTimeout    time.Duration
	SessionTimeout time.Duration
	IdleTimeout    time.Duration
	MaxBytesPerWay int64
}

type waitingHost struct {
	conn    *websocket.Conn
	matched chan *websocket.Conn
	done    chan struct{}
}

type deviceState struct {
	hostHash, viewerHash [32]byte
	waiting              []*waitingHost
	active               int
	window               time.Time
	requests             int
}

type Server struct {
	cfg     Config
	mu      sync.Mutex
	devices map[string]*deviceState
	open    int
	ctx     context.Context
	cancel  context.CancelFunc
}

func NewServer(cfg Config) (*Server, error) {
	if len(cfg.Devices) == 0 || len(cfg.Devices) > 10000 {
		return nil, errors.New("configure between 1 and 10000 relay devices")
	}
	if cfg.MaxConnections <= 0 {
		cfg.MaxConnections = 512
	}
	if cfg.MaxWaiting <= 0 {
		cfg.MaxWaiting = 8
	}
	if cfg.MaxActive <= 0 {
		cfg.MaxActive = 8
	}
	if cfg.WaitTimeout <= 0 {
		cfg.WaitTimeout = 90 * time.Second
	}
	if cfg.SessionTimeout <= 0 {
		cfg.SessionTimeout = time.Hour
	}
	if cfg.IdleTimeout <= 0 {
		cfg.IdleTimeout = 60 * time.Second
	}
	if cfg.MaxBytesPerWay <= 0 {
		cfg.MaxBytesPerWay = 4 << 30
	}
	s := &Server{cfg: cfg, devices: make(map[string]*deviceState)}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	for id, credentials := range cfg.Devices {
		if !validDevice.MatchString(id) || !validToken.MatchString(credentials.HostToken) || !validToken.MatchString(credentials.ViewerToken) || credentials.HostToken == credentials.ViewerToken {
			s.cancel()
			return nil, errors.New("device IDs or role tokens are invalid; use distinct random tokens of at least 32 characters")
		}
		s.devices[id] = &deviceState{hostHash: sha256.Sum256([]byte(credentials.HostToken)), viewerHash: sha256.Sum256([]byte(credentials.ViewerToken))}
	}
	// Do not retain the plaintext secret map once its hashes have been loaded.
	s.cfg.Devices = nil
	return s, nil
}

func (s *Server) Close() { s.cancel() }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
		return
	}
	if r.URL.Path != "/v1/tunnel" || r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	// Native clients do not send Origin. Reject browser-originated upgrade attempts.
	if r.Header.Get("Origin") != "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	id, role := r.URL.Query().Get("device"), r.URL.Query().Get("role")
	auth := r.Header.Get("Authorization")
	if len(auth) > 300 || !strings.HasPrefix(auth, "Bearer ") {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	hash := sha256.Sum256([]byte(strings.TrimPrefix(auth, "Bearer ")))
	s.mu.Lock()
	state := s.devices[id]
	var expected [32]byte
	if state != nil {
		if role == "host" {
			expected = state.hostHash
		} else if role == "viewer" {
			expected = state.viewerHash
		}
	}
	valid := subtle.ConstantTimeCompare(hash[:], expected[:]) == 1 && state != nil && (role == "host" || role == "viewer")
	if !valid {
		s.mu.Unlock()
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if time.Since(state.window) >= time.Minute {
		state.window = time.Now()
		state.requests = 0
	}
	state.requests++
	if state.requests > 240 || s.open >= s.cfg.MaxConnections || (role == "host" && len(state.waiting) >= s.cfg.MaxWaiting) || (role == "viewer" && state.active >= s.cfg.MaxActive) {
		s.mu.Unlock()
		http.Error(w, "capacity reached", http.StatusTooManyRequests)
		return
	}
	var waiting *waitingHost
	if role == "viewer" {
		if len(state.waiting) == 0 {
			s.mu.Unlock()
			http.Error(w, "host unavailable", http.StatusServiceUnavailable)
			return
		}
		waiting = state.waiting[0]
		state.waiting = state.waiting[1:]
		state.active++
	}
	s.open++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.open--
		if role == "viewer" {
			state.active--
		}
		s.mu.Unlock()
	}()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		if waiting != nil {
			select {
			case waiting.matched <- nil:
			case <-waiting.done:
			}
		}
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	if role == "viewer" {
		select {
		case waiting.matched <- conn:
		case <-waiting.done:
			return
		case <-s.ctx.Done():
			return
		}
		select {
		case <-waiting.done:
		case <-s.ctx.Done():
		}
		return
	}
	waiting = &waitingHost{conn: conn, matched: make(chan *websocket.Conn), done: make(chan struct{})}
	defer close(waiting.done)
	s.mu.Lock()
	// Concurrent upgrades can finish after the initial admission check.
	if len(state.waiting) >= s.cfg.MaxWaiting {
		s.mu.Unlock()
		return
	}
	state.waiting = append(state.waiting, waiting)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		for i, candidate := range state.waiting {
			if candidate == waiting {
				state.waiting = append(state.waiting[:i], state.waiting[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
	}()
	timer := time.NewTimer(s.cfg.WaitTimeout)
	defer timer.Stop()
	select {
	case viewer := <-waiting.matched:
		if viewer != nil {
			s.bridge(conn, viewer)
		}
	case <-timer.C:
	case <-s.ctx.Done():
	}
}

func (s *Server) bridge(a, b *websocket.Conn) {
	ctx, cancel := context.WithTimeout(s.ctx, s.cfg.SessionTimeout)
	defer cancel()
	left := websocket.NetConn(ctx, a, websocket.MessageBinary)
	right := websocket.NetConn(ctx, b, websocket.MessageBinary)
	defer left.Close()
	defer right.Close()
	done := make(chan struct{}, 2)
	copyBounded := func(dst, src net.Conn) {
		buffer := make([]byte, 32*1024)
		remaining := s.cfg.MaxBytesPerWay
		for remaining > 0 {
			_ = src.SetReadDeadline(time.Now().Add(s.cfg.IdleTimeout))
			n, err := src.Read(buffer[:min(int64(len(buffer)), remaining)])
			if n > 0 {
				_ = dst.SetWriteDeadline(time.Now().Add(s.cfg.IdleTimeout))
				written, writeErr := dst.Write(buffer[:n])
				remaining -= int64(written)
				if writeErr != nil || written != n {
					break
				}
			}
			if err != nil {
				break
			}
		}
		done <- struct{}{}
	}
	go copyBounded(left, right)
	go copyBounded(right, left)
	select {
	case <-done:
	case <-ctx.Done():
	}
	// An EOF/error in either direction terminates the pair, preventing orphan streams.
	cancel()
	_ = a.CloseNow()
	_ = b.CloseNow()
}

var _ http.Handler = (*Server)(nil)
