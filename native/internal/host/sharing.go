package host

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/flazedude/Remoter/native/internal/platform"
)

type audioPacket struct {
	Sequence   uint64 `json:"sequence"`
	Data       []byte `json:"data"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
}

// Capture is lazy, shared among listeners, and stops after three idle seconds.
// The ring bounds both latency and memory when a connection falls behind.
type audioHub struct {
	mu       sync.Mutex
	packets  []audioPacket
	sequence uint64
	changed  chan struct{}
	cancel   context.CancelFunc
	lastRead time.Time
	err      error
	closed   bool
}

func (a *audioHub) wake() {
	if a.changed != nil {
		close(a.changed)
	}
	a.changed = make(chan struct{})
}
func (a *audioHub) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	if a.cancel != nil {
		a.cancel()
	}
	a.wake()
}
func (a *audioHub) next(ctx context.Context, sharing platform.Sharing, after uint64) (audioPacket, error) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return audioPacket{}, errors.New("host stopped")
	}
	a.lastRead = time.Now()
	if a.cancel == nil {
		captureCtx, cancel := context.WithCancel(context.Background())
		a.cancel = cancel
		a.err = nil
		a.packets = nil
		a.wake()
		go func() {
			idleDone := make(chan struct{})
			go func() {
				ticker := time.NewTicker(time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-idleDone:
						return
					case <-ticker.C:
						a.mu.Lock()
						idle := time.Since(a.lastRead) > 3*time.Second
						a.mu.Unlock()
						if idle {
							cancel()
							return
						}
					}
				}
			}()
			err := sharing.CaptureAudio(captureCtx, func(data []byte) {
				a.mu.Lock()
				defer a.mu.Unlock()
				a.sequence++
				a.packets = append(a.packets, audioPacket{a.sequence, data, 48000, 2})
				if len(a.packets) > 20 {
					a.packets = a.packets[len(a.packets)-20:]
				}
				a.wake()
			})
			close(idleDone)
			cancel()
			a.mu.Lock()
			defer a.mu.Unlock()
			a.cancel = nil
			a.err = err
			a.wake()
		}()
	}
	for {
		if a.closed {
			a.mu.Unlock()
			return audioPacket{}, errors.New("host stopped")
		}
		if a.err != nil {
			err := a.err
			a.mu.Unlock()
			return audioPacket{}, err
		}
		for i, packet := range a.packets {
			if packet.Sequence > after {
				// New listeners begin at the live edge.
				if after == 0 || i < len(a.packets)-4 {
					packet = a.packets[len(a.packets)-1]
				}
				a.mu.Unlock()
				return packet, nil
			}
		}
		changed := a.changed
		a.mu.Unlock()
		select {
		case <-ctx.Done():
			return audioPacket{}, ctx.Err()
		case <-changed:
		}
		a.mu.Lock()
	}
}

func (h *Handler) clipboard(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.AllowClipboard || h.cfg.Sharing == nil {
		fail(w, 403, "clipboard sharing is disabled on this host")
		return
	}
	if !h.clipboardLimit.allow(20) {
		fail(w, 429, "clipboard rate limit reached")
		return
	}
	switch r.Method {
	case "GET":
		after := r.URL.Query().Get("after")
		var previous [32]byte
		if after != "" {
			decoded, err := hex.DecodeString(after)
			if err != nil || len(decoded) != len(previous) {
				fail(w, 400, "invalid clipboard revision")
				return
			}
			copy(previous[:], decoded)
		}
		text, err := h.cfg.Sharing.ReadClipboard()
		if err == nil && after != "" {
			// SendInput can return before the target app processes Copy/Cut.
			// Wait briefly for new text rather than returning its old clipboard.
			deadline := time.NewTimer(400 * time.Millisecond)
			defer deadline.Stop()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
		wait:
			for sha256.Sum256([]byte(text)) == previous {
				select {
				case <-h.stop:
					return
				case <-r.Context().Done():
					return
				case <-deadline.C:
					break wait
				case <-ticker.C:
					text, err = h.cfg.Sharing.ReadClipboard()
					if err != nil {
						break wait
					}
				}
			}
		}
		if err != nil {
			fail(w, 503, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"text": text})
	case "POST":
		r.Body = http.MaxBytesReader(w, r.Body, platform.MaxClipboardBytes*6+64)
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		var value struct {
			Text *string `json:"text"`
		}
		if dec.Decode(&value) != nil || value.Text == nil || dec.Decode(&struct{}{}) != io.EOF || len(*value.Text) > platform.MaxClipboardBytes || !utf8.ValidString(*value.Text) || strings.ContainsRune(*value.Text, 0) {
			fail(w, 400, "invalid clipboard text (maximum 1 MiB)")
			return
		}
		if err := h.cfg.Sharing.WriteClipboard(*value.Text); err != nil {
			fail(w, 503, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		fail(w, 405, "method not allowed")
	}
}
func (h *Handler) audio(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		fail(w, 405, "method not allowed")
		return
	}
	if !h.cfg.AllowAudio || h.cfg.Sharing == nil {
		fail(w, 403, "audio sharing is disabled on this host")
		return
	}
	if !h.audioLimit.allow(100) {
		fail(w, 429, "audio rate limit reached")
		return
	}
	after, err := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	if err != nil {
		fail(w, 400, "invalid audio sequence")
		return
	}
	select {
	case h.audioReaders <- struct{}{}:
		defer func() { <-h.audioReaders }()
	default:
		fail(w, 429, "too many audio readers")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	packet, err := h.audioHub.next(ctx, h.cfg.Sharing, after)
	if errors.Is(err, context.DeadlineExceeded) {
		writeJSON(w, 200, audioPacket{Sequence: after, Data: []byte{}, SampleRate: 48000, Channels: 2})
		return
	}
	if err != nil {
		fail(w, 503, "system audio capture unavailable: "+err.Error())
		return
	}
	writeJSON(w, 200, packet)
}
