//go:build windows

package platform

import (
	"bytes"
	"image/jpeg"
	"os"
	"testing"
)

// This is deliberately opt-in: ordinary test runs must never read a user's
// desktop. The check retains pixels only in memory and reports dimensions and
// byte count; it neither saves an image nor calls the input API.
func TestOptInRealWindowsCapture(t *testing.T) {
	if os.Getenv("REMOTER_TEST_REAL_CAPTURE") != "1" {
		t.Skip("set REMOTER_TEST_REAL_CAPTURE=1 for a real capture metadata-only check")
	}
	b := NewNative()
	displays, err := b.Displays()
	if err != nil {
		t.Fatal(err)
	}
	if len(displays) == 0 {
		t.Fatal("no active display")
	}
	im, err := b.Capture(displays[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err = jpeg.Encode(&encoded, im, &jpeg.Options{Quality: 65}); err != nil {
		t.Fatal(err)
	}
	if im.Bounds().Dx() < 1 || im.Bounds().Dy() < 1 || encoded.Len() < 4 {
		t.Fatal("empty capture")
	}
	t.Logf("Capture succeeded: width=%d height=%d JPEG bytes=%d; no image saved; no input injected", im.Bounds().Dx(), im.Bounds().Dy(), encoded.Len())
}
