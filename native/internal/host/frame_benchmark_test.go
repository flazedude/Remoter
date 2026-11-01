package host

import (
	"bytes"
	"image"
	"image/jpeg"
	"testing"
)

// Synthetic pixels only: this benchmark never captures a desktop.
func BenchmarkFrameProcessing(b *testing.B) {
	src := image.NewRGBA(image.Rect(0, 0, 3840, 2160))
	for i := range src.Pix {
		src.Pix[i] = byte(i * 31)
	}
	for _, width := range []int{3840, 1920, 1600, 1280} {
		b.Run(fmtWidth(width), func(b *testing.B) {
			for b.Loop() {
				var out bytes.Buffer
				im := image.Image(src)
				if width < src.Bounds().Dx() {
					im = resize(src, width)
				}
				if err := jpeg.Encode(&out, im, &jpeg.Options{Quality: 85}); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func fmtWidth(width int) string {
	switch width {
	case 3840:
		return "4K"
	case 1920:
		return "1080p"
	case 1600:
		return "900p"
	default:
		return "720p"
	}
}
