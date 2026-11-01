//go:build windows

package platform

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestSystemAudioInitialization(t *testing.T) {
	if os.Getenv("REMOTER_TEST_SYSTEM_AUDIO") != "1" {
		t.Skip("set REMOTER_TEST_SYSTEM_AUDIO=1 to initialize real Windows loopback capture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if err := NewSharing().CaptureAudio(ctx, func(data []byte) {
		if len(data) != 9600 {
			t.Error("invalid PCM packet size")
		}
	}); err != nil {
		t.Fatal(err)
	}
}
