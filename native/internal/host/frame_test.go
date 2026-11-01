package host

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flazedude/Remoter/native/internal/platform"
)

func TestResizeRGBAAndGenericWithOffsetBounds(t *testing.T) {
	for _, src := range []interface {
		image.Image
		Set(int, int, color.Color)
	}{
		image.NewRGBA(image.Rect(13, 17, 21, 23)), image.NewNRGBA(image.Rect(13, 17, 21, 23)),
	} {
		for y := 17; y < 23; y++ {
			for x := 13; x < 21; x++ {
				src.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
			}
		}
		dst := resize(src, 4)
		if dst.Bounds() != image.Rect(0, 0, 4, 3) {
			t.Fatal(dst.Bounds())
		}
		for y := 0; y < 3; y++ {
			for x := 0; x < 4; x++ {
				r, g, b, a := dst.At(x, y).RGBA()
				sr, sg, sb, sa := src.At(13+x*2, 17+y*2).RGBA()
				if r != sr || g != sg || b != sb || a != sa {
					t.Fatalf("incorrect sample %d,%d", x, y)
				}
			}
		}
	}
}

type sizedBackend struct {
	*platform.Synthetic
	width    atomic.Int64
	captures atomic.Int64
}

func (b *sizedBackend) CaptureSized(id, width int) (image.Image, error) {
	b.width.Store(int64(width))
	b.captures.Add(1)
	return image.NewRGBA(image.Rect(0, 0, width, width/2)), nil
}

func TestCapturePrefetchIsBoundedAndRefreshesConfigurationAndStaleFrames(t *testing.T) {
	b := &sizedBackend{Synthetic: platform.NewSynthetic()}
	h, err := NewHandler(Config{Token: testToken, Backend: b})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if _, err = h.nextCapture(0, 640); err != nil {
		t.Fatal(err)
	}
	// Wait for the one prefetched capture, then prove it does not loop.
	deadline := time.Now().Add(time.Second)
	for b.captures.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	if b.captures.Load() != 2 {
		t.Fatalf("unbounded prefetch: %d", b.captures.Load())
	}
	im, err := h.nextCapture(0, 800)
	if err != nil || im.Bounds().Dx() != 800 {
		t.Fatalf("old resolution reused: %v", err)
	}
	h.prefetched.started = time.Now().Add(-time.Second)
	before := b.captures.Load()
	if _, err = h.nextCapture(0, 800); err != nil {
		t.Fatal(err)
	}
	if b.captures.Load() <= before {
		t.Fatal("stale capture was reused")
	}
}
func TestFrameUsesSizedCapture(t *testing.T) {
	backend := &sizedBackend{Synthetic: platform.NewSynthetic()}
	h, err := NewHandler(Config{Token: testToken, Backend: backend})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	response := request(h, "GET", "/v1/frame?width=640", "", testToken)
	if response.Code != 200 || backend.width.Load() != 640 {
		t.Fatalf("status=%d width=%d", response.Code, backend.width.Load())
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(response.Body.Bytes()))
	if err != nil || cfg.Width != 640 || cfg.Height != 320 {
		t.Fatalf("invalid sized JPEG: %+v %v", cfg, err)
	}
}

// Metadata only: no pixels leave memory and no keyboard/mouse input is sent.
func TestOptInCapturePerformance(t *testing.T) {
	if os.Getenv("REMOTER_TEST_REAL_CAPTURE") != "1" {
		t.Skip("opt-in desktop capture measurement")
	}
	backend := platform.NewNative()
	sized, ok := backend.(interface {
		CaptureSized(int, int) (image.Image, error)
	})
	if !ok {
		t.Skip("sized capture not supported")
	}
	displays, err := backend.Displays()
	if err != nil || len(displays) == 0 {
		t.Fatalf("displays: %v", err)
	}
	for _, width := range []int{3840, 1920, 1600, 1280} {
		start := time.Now()
		var size int
		var bounds image.Rectangle
		var captureTime time.Duration
		for i := 0; i < 12; i++ {
			captureStart := time.Now()
			im, err := sized.CaptureSized(displays[0].ID, width)
			captureTime += time.Since(captureStart)
			if err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			quality := 80
			if width == 3840 {
				quality = 90
			}
			if err = jpeg.Encode(&out, im, &jpeg.Options{Quality: quality}); err != nil {
				t.Fatal(err)
			}
			cfg, err := jpeg.DecodeConfig(bytes.NewReader(out.Bytes()))
			if err != nil || cfg.Width != im.Bounds().Dx() {
				t.Fatalf("invalid JPEG: %v", err)
			}
			bounds = im.Bounds()
			size = out.Len()
		}
		elapsed := time.Since(start).Seconds() / 12
		t.Logf("capture+JPEG requested=%d actual=%dx%d average=%.1fms ceiling=%.1f FPS bytes=%d", width, bounds.Dx(), bounds.Dy(), elapsed*1000, 1/elapsed, size)
		t.Logf("capture alone %.1fms", captureTime.Seconds()*1000/12)
	}
	h, err := NewHandler(Config{Token: testToken, Backend: backend})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	for _, width := range []int{1920, 1600, 1280} {
		start := time.Now()
		for i := 0; i < 30; i++ {
			im, err := h.nextCapture(displays[0].ID, width)
			if err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err = jpeg.Encode(&out, im, &jpeg.Options{Quality: 80}); err != nil {
				t.Fatal(err)
			}
		}
		elapsed := time.Since(start).Seconds() / 30
		t.Logf("pipelined capture+JPEG width=%d average=%.1fms ceiling=%.1f FPS", width, elapsed*1000, 1/elapsed)
	}
}
