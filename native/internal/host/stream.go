package host

import (
	"bytes"
	"encoding/binary"
	"net/http"
	"time"
)

// Stream frames on one authenticated TLS connection. Each frame has a bounded
// 20-byte big-endian header: JPEG size, width, height, capture µs, encode µs.
// The next capture overlaps encoding/transfer; writes provide backpressure.
func (h *Handler) stream(w http.ResponseWriter, r *http.Request) {
	display, err := parseInt(r, "display", 0, 0, 31)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	quality, err := parseInt(r, "quality", 85, 20, 90)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	width, err := parseInt(r, "width", 1920, 320, 3840)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	fps, err := parseInt(r, "fps", 30, 1, 30)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !h.frameLimit.allow(40) {
		fail(w, 429, "frame rate limit reached")
		return
	}
	select {
	case h.frames <- struct{}{}:
		defer func() { <-h.frames }()
	default:
		fail(w, 429, "capture busy")
		return
	}
	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "application/x-remoter-frames; version=1")
	period := time.Second / time.Duration(fps)
	next := time.Now()
	var output bytes.Buffer
	for !h.closed.Load() && r.Context().Err() == nil {
		capture := h.takeCapture(display, width)
		im, err := capture.image, capture.err
		captured := time.Now()
		if err != nil {
			return
		}
		bounds := im.Bounds()
		if bounds.Dx() < 1 || bounds.Dy() < 1 || int64(bounds.Dx())*int64(bounds.Dy()) > 40000000 {
			return
		}
		if bounds.Dx() > width {
			im = resize(im, width)
		}
		output.Reset()
		if err := encodeJPEG(&output, im, quality); err != nil || output.Len() > 16*1024*1024 {
			return
		}
		encoded := time.Now()
		header := [20]byte{}
		for i, value := range []uint32{uint32(output.Len()), uint32(im.Bounds().Dx()), uint32(im.Bounds().Dy()), uint32(capture.duration.Microseconds()), uint32(encoded.Sub(captured).Microseconds())} {
			binary.BigEndian.PutUint32(header[i*4:], value)
		}
		// Reset the server's ordinary request deadline for every streamed frame.
		// A stalled/paused consumer cannot retain the capture slot indefinitely.
		_ = controller.SetWriteDeadline(time.Now().Add(3 * time.Second))
		if _, err = w.Write(header[:]); err != nil {
			return
		}
		if _, err = w.Write(output.Bytes()); err != nil {
			return
		}
		if err = controller.Flush(); err != nil {
			return
		}
		next = next.Add(period)
		if next.Before(time.Now()) {
			next = time.Now()
		}
		timer := time.NewTimer(time.Until(next))
		select {
		case <-timer.C:
		case <-r.Context().Done():
			timer.Stop()
			return
		case <-h.stop:
			timer.Stop()
			return
		}
	}
}
