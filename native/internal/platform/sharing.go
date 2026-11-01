package platform

import (
	"context"
	"time"
)

// Audio is interleaved 48 kHz stereo signed 16-bit little-endian PCM.
type Sharing interface {
	ReadClipboard() (string, error)
	WriteClipboard(string) error
	CaptureAudio(context.Context, func([]byte)) error
}

const MaxClipboardBytes = 1024 * 1024

// Synthetic sharing never touches operating-system audio or clipboard data.
func (s *Synthetic) ReadClipboard() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clipboard, nil
}
func (s *Synthetic) WriteClipboard(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clipboard = text
	return nil
}
func (s *Synthetic) CaptureAudio(ctx context.Context, emit func([]byte)) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			emit(make([]byte, 9600))
		}
	}
}
