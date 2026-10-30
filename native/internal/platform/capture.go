//go:build windows

package platform

import (
	"fmt"
	"github.com/kbinani/screenshot"
	"image"
)

func (*Native) Displays() (ds []Display, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("display enumeration failed: %v", r)
		}
	}()
	n := screenshot.NumActiveDisplays()
	if n == 0 {
		return nil, fmt.Errorf("no active display; a logged-in desktop may be required")
	}
	if n > 32 {
		n = 32
	}
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		ds = append(ds, Display{i, fmt.Sprintf("Display %d", i+1), b.Dx(), b.Dy(), b.Min.X, b.Min.Y})
	}
	return ds, nil
}
func (n *Native) Capture(id int) (im image.Image, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("screen capture failed: %v", r)
		}
	}()
	if !n.Capabilities().Capture {
		return nil, fmt.Errorf("screen capture permission is required")
	}
	ds, e := n.Displays()
	if e != nil {
		return nil, e
	}
	d, e := DisplayBounds(ds, id)
	if e != nil {
		return nil, e
	}
	if d.Width <= 0 || d.Height <= 0 || d.Width > 16384 || d.Height > 16384 || int64(d.Width)*int64(d.Height) > 40000000 {
		return nil, fmt.Errorf("display exceeds capture limit")
	}
	return screenshot.CaptureRect(image.Rect(d.X, d.Y, d.X+d.Width, d.Y+d.Height))
}
