//go:build (!darwin || !cgo) && (!windows || (!amd64 && !arm64))

package host

import (
	"bytes"
	"image"
	"image/jpeg"
)

func encodeJPEG(out *bytes.Buffer, im image.Image, quality int) error {
	return jpeg.Encode(out, im, &jpeg.Options{Quality: quality})
}
