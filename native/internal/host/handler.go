package host

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/flazedude/Remoter/native/internal/platform"
)

const Version = "0.1.0-alpha"

type Config struct {
	Name, Token    string
	AllowInput     bool
	Synthetic      bool
	Backend        platform.Backend
	AllowClipboard bool
	AllowAudio     bool
	Sharing        platform.Sharing
	LANToken       string
	LANInvitation  string
}
type Handler struct {
	cfg            Config
	tokenHash      [32]byte
	frames         chan struct{}
	inputMu        sync.Mutex
	held           map[string]platform.InputEvent
	lastInput      time.Time
	frameLimit     limiter
	inputLimit     limiter
	stop           chan struct{}
	once           sync.Once
	closed         atomic.Bool
	clipboardLimit limiter
	audioLimit     limiter
	audioHub       audioHub
	audioReaders   chan struct{}
}
type limiter struct {
	mu    sync.Mutex
	since time.Time
	count int
}

func (l *limiter) allow(max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.since) >= time.Second {
		l.since = now
		l.count = 0
	}
	if l.count >= max {
		return false
	}
	l.count++
	return true
}
func NewHandler(cfg Config) (*Handler, error) {
	if len(cfg.Token) < 32 {
		return nil, errors.New("host token must contain at least 32 characters")
	}
	if cfg.Backend == nil {
		if cfg.Synthetic {
			cfg.Backend = platform.NewSynthetic()
		} else {
			cfg.Backend = platform.NewNative()
		}
	}
	if cfg.Name == "" {
		cfg.Name = "Remoter host"
	}
	if cfg.Sharing == nil && cfg.Synthetic {
		cfg.Sharing, _ = cfg.Backend.(platform.Sharing)
	}
	if cfg.Sharing == nil && !cfg.Synthetic && platform.SharingAvailable() {
		cfg.Sharing = platform.NewSharing()
	}
	h := &Handler{cfg: cfg, tokenHash: sha256.Sum256([]byte(cfg.Token)), frames: make(chan struct{}, 1), held: map[string]platform.InputEvent{}, stop: make(chan struct{}), audioReaders: make(chan struct{}, 4)}
	go h.releaseIdleInputs()
	return h, nil
}
func (h *Handler) Close() {
	h.once.Do(func() {
		h.closed.Store(true)
		close(h.stop)
		h.audioHub.close()
		h.inputMu.Lock()
		defer h.inputMu.Unlock()
		h.releaseHeld()
	})
}
func (h *Handler) releaseIdleInputs() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-h.stop:
			return
		case <-t.C:
			h.inputMu.Lock()
			if len(h.held) > 0 && time.Since(h.lastInput) > 5*time.Second {
				h.releaseHeld()
			}
			h.inputMu.Unlock()
		}
	}
}
func (h *Handler) releaseHeld() {
	for k, e := range h.held {
		e.Down = false
		_ = h.cfg.Backend.Input(e)
		delete(h.held, k)
	}
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

type relayContextKey struct{}

func (h *Handler) ServeRelayHTTP(w http.ResponseWriter, r *http.Request) {
	h.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), relayContextKey{}, true)))
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	auth := r.Header.Get("Authorization")
	provided := sha256.Sum256([]byte(strings.TrimPrefix(auth, "Bearer ")))
	lanPeer := h.cfg.LANToken != "" && r.Context().Value(relayContextKey{}) != true && localPeer(r.RemoteAddr)
	// Bootstrap is unavailable to browser origins and non-LAN/relay peers.
	if r.URL.Path == "/v1/lan-pair" && lanPeer && r.Header.Get("Origin") == "" && !h.closed.Load() {
		if r.Method != "GET" {
			fail(w, 405, "method not allowed")
			return
		}
		writeJSON(w, 200, map[string]string{"invitation": h.cfg.LANInvitation})
		return
	}
	lanHash := sha256.Sum256([]byte(h.cfg.LANToken))
	validLAN := lanPeer && subtle.ConstantTimeCompare(provided[:], lanHash[:]) == 1
	if !strings.HasPrefix(auth, "Bearer ") || (subtle.ConstantTimeCompare(provided[:], h.tokenHash[:]) != 1 && !validLAN) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		fail(w, 401, "authentication required")
		return
	}
	if h.closed.Load() {
		fail(w, 503, "host is stopping")
		return
	}
	// Only native app traffic is supported. Do not expose host access through an
	// unrelated browser origin, even when a pairing token was copied there.
	if r.Header.Get("Origin") != "" {
		fail(w, 403, "browser-origin requests are not supported")
		return
	}
	switch r.URL.Path {
	case "/v1/clipboard":
		h.clipboard(w, r)
	case "/v1/audio":
		h.audio(w, r)
	case "/v1/health":
		if r.Method != "GET" {
			fail(w, 405, "method not allowed")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "version": Version, "synthetic": h.cfg.Synthetic})
	case "/v1/info":
		if r.Method != "GET" {
			fail(w, 405, "method not allowed")
			return
		}
		h.info(w)
	case "/v1/frame":
		if r.Method != "GET" {
			fail(w, 405, "method not allowed")
			return
		}
		h.frame(w, r)
	case "/v1/input":
		if r.Method != "POST" {
			fail(w, 405, "method not allowed")
			return
		}
		h.input(w, r)
	default:
		fail(w, 404, "not found")
	}
}
func (h *Handler) info(w http.ResponseWriter) {
	ds, err := h.cfg.Backend.Displays()
	if ds == nil {
		ds = []platform.Display{}
	}
	caps := h.cfg.Backend.Capabilities()
	caps.Input = caps.Input && h.cfg.AllowInput
	result := map[string]any{"name": h.cfg.Name, "os": runtime.GOOS, "version": Version, "capabilities": caps, "displays": ds, "synthetic": h.cfg.Synthetic}
	result["capabilities"] = map[string]bool{"capture": caps.Capture, "input": caps.Input, "clipboard": h.cfg.AllowClipboard && h.cfg.Sharing != nil, "audio": h.cfg.AllowAudio && h.cfg.Sharing != nil}
	if err != nil {
		result["warning"] = err.Error()
	}
	writeJSON(w, 200, result)
}
func parseInt(r *http.Request, key string, fallback, min, max int) (int, error) {
	s := r.URL.Query().Get(key)
	if s == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < min || v > max {
		return 0, errors.New("invalid " + key)
	}
	return v, nil
}
func (h *Handler) frame(w http.ResponseWriter, r *http.Request) {
	display, err := parseInt(r, "display", 0, 0, 31)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	quality, err := parseInt(r, "quality", 65, 20, 90)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	width, err := parseInt(r, "width", 1280, 320, 3840)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !h.frameLimit.allow(30) {
		fail(w, 429, "frame rate limit reached")
		return
	}
	select {
	case h.frames <- struct{}{}:
		defer func() { <-h.frames }()
	case <-r.Context().Done():
		return
	default:
		fail(w, 429, "capture busy")
		return
	}
	im, err := h.cfg.Backend.Capture(display)
	if err != nil {
		fail(w, 503, err.Error())
		return
	}
	bounds := im.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 || int64(bounds.Dx())*int64(bounds.Dy()) > 40000000 {
		fail(w, 503, "invalid capture dimensions")
		return
	}
	if bounds.Dx() > width {
		im = resize(im, width)
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, im, &jpeg.Options{Quality: quality}); err != nil {
		fail(w, 500, "frame encoding failed")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.Itoa(b.Len()))
	w.Header().Set("X-Frame-Width", strconv.Itoa(im.Bounds().Dx()))
	w.Header().Set("X-Frame-Height", strconv.Itoa(im.Bounds().Dy()))
	w.WriteHeader(200)
	_, _ = w.Write(b.Bytes())
}
func resize(src image.Image, width int) image.Image {
	b := src.Bounds()
	height := b.Dy() * width / b.Dx()
	if height < 1 {
		height = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		sy := b.Min.Y + y*b.Dy()/height
		for x := 0; x < width; x++ {
			dst.Set(x, y, src.At(b.Min.X+x*b.Dx()/width, sy))
		}
	}
	return dst
}
func (h *Handler) input(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.AllowInput || !h.cfg.Backend.Capabilities().Input {
		fail(w, 403, "host is view-only or input permission is unavailable")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2048)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var e platform.InputEvent
	if err := dec.Decode(&e); err != nil {
		fail(w, 400, "invalid input JSON")
		return
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		fail(w, 400, "expected a single JSON object")
		return
	}
	if e.Type != "releaseAll" && !h.inputLimit.allow(240) {
		fail(w, 429, "input rate limit reached")
		return
	}
	ds, err := h.cfg.Backend.Displays()
	if err != nil && e.Type == "move" {
		fail(w, 503, err.Error())
		return
	}
	if err := platform.ValidateEvent(e, ds); err != nil {
		fail(w, 400, err.Error())
		return
	}
	h.inputMu.Lock()
	defer h.inputMu.Unlock()
	if h.closed.Load() {
		fail(w, 503, "host is stopping")
		return
	}
	if e.Type == "releaseAll" {
		h.releaseHeld()
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if err := h.cfg.Backend.Input(e); err != nil {
		fail(w, 503, err.Error())
		return
	}
	h.lastInput = time.Now()
	if e.Type == "key" || e.Type == "button" {
		key := e.Type + ":" + e.Code + e.Button
		if e.Down {
			h.held[key] = e
		} else {
			delete(h.held, key)
		}
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
