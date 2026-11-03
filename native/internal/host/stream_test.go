package host

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNativeJPEGDimensionsAndColors(t *testing.T) {
	for _, quality := range []int{20, 85, 90} {
		src := image.NewRGBA(image.Rect(7, 11, 135, 75))
		for y := 11; y < 75; y++ {
			for x := 7; x < 135; x++ {
				src.SetRGBA(x, y, color.RGBA{220, 30, 60, 255})
			}
		}
		var out bytes.Buffer
		if err := encodeJPEG(&out, src, quality); err != nil {
			t.Fatal(err)
		}
		im, err := jpeg.Decode(&out)
		if err != nil {
			t.Fatal(err)
		}
		if im.Bounds() != image.Rect(0, 0, 128, 64) {
			t.Fatal(im.Bounds())
		}
		r, g, b, _ := im.At(50, 30).RGBA()
		if r/257 < 190 || g/257 > 60 || b/257 > 90 {
			t.Fatalf("swapped colors: %d,%d,%d", r/257, g/257, b/257)
		}
	}
}
func TestStreamPacingInputAndCancellation(t *testing.T) {
	h, err := NewHandler(Config{Token: testToken, Synthetic: true, AllowInput: true})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	server := httptest.NewServer(h)
	defer server.Close()
	req, _ := http.NewRequest("GET", server.URL+"/v1/stream?width=640&fps=30", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	start := time.Now()
	for i := 0; i < 35; i++ {
		var header [20]byte
		if _, err := io.ReadFull(response.Body, header[:]); err != nil {
			t.Fatal(err)
		}
		size := binary.BigEndian.Uint32(header[:4])
		width := binary.BigEndian.Uint32(header[4:8])
		if size > 16*1024*1024 || width != 640 {
			t.Fatalf("bad stream header: %v", header)
		}
		data := make([]byte, size)
		if _, err := io.ReadFull(response.Body, data); err != nil {
			t.Fatal(err)
		}
		if _, err := jpeg.DecodeConfig(bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		if i == 10 {
			if got := request(h, "POST", "/v1/input", `{"type":"key","code":"KeyA","down":true}`, testToken).Code; got != 200 {
				t.Fatalf("input starved: %d", got)
			}
		}
	}
	elapsed := time.Since(start)
	if elapsed < time.Second || elapsed > 2*time.Second {
		t.Fatalf("unexpected 30fps pacing: %v", elapsed)
	}
	response.Body.Close()
	deadline := time.Now().Add(time.Second)
	for len(h.frames) != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(h.frames) != 0 {
		t.Fatal("stream did not release capture slot after cancellation")
	}
	if got := request(h, "GET", "/v1/frame?width=640", "", testToken).Code; got != 200 {
		t.Fatalf("snapshot unavailable after cancellation: %d", got)
	}
}
func TestStreamRejectsUnauthenticatedAndInvalidConfiguration(t *testing.T) {
	h, _ := NewHandler(Config{Token: testToken, Synthetic: true})
	defer h.Close()
	for _, path := range []string{"/v1/stream?fps=31", "/v1/stream?width=99999", "/v1/stream?display=32", "/v1/stream?quality=91"} {
		if got := request(h, "GET", path, "", testToken).Code; got != 400 {
			t.Fatalf("%s: %d", path, got)
		}
	}
	if got := request(h, "GET", "/v1/stream", "", "bad").Code; got != 401 {
		t.Fatal(got)
	}
	if got := request(h, "POST", "/v1/stream", "", testToken).Code; got != 405 {
		t.Fatal(got)
	}
}

func TestInputBatchIsValidatedBeforePressingKeys(t *testing.T) {
	h, _ := NewHandler(Config{Token: testToken, Synthetic: true, AllowInput: true})
	defer h.Close()
	invalid := `{"events":[{"type":"key","code":"KeyA","down":true},{"type":"key","code":"Invalid"}]}`
	if got := request(h, "POST", "/v1/inputs", invalid, testToken).Code; got != 400 {
		t.Fatal(got)
	}
	if len(h.held) != 0 {
		t.Fatal("invalid batch left a key pressed")
	}
	valid := `{"events":[{"type":"key","code":"KeyA","down":true},{"type":"key","code":"KeyA","down":false},{"type":"button","button":"left","down":true},{"type":"releaseAll"}]}`
	if got := request(h, "POST", "/v1/inputs", valid, testToken).Code; got != 200 {
		t.Fatal(got)
	}
	if len(h.held) != 0 {
		t.Fatal("release did not clear held input")
	}
	for _, body := range []string{`{"events":[]}`, `{"events":[{"type":"releaseAll","unknown":true}]}`, `{"events":[{"type":"releaseAll"}]} {}`} {
		if got := request(h, "POST", "/v1/inputs", body, testToken).Code; got != 400 {
			t.Fatal(got)
		}
	}
}
