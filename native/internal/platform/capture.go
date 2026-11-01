//go:build windows

package platform

import (
	"fmt"
	"github.com/kbinani/screenshot"
	"github.com/lxn/win"
	"image"
	"runtime"
	"unsafe"
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
	return n.CaptureSized(id, 16384)
}

// Scale during the GDI copy, before reading pixels back to Go. This avoids
// allocating and resizing an entire 4K frame when the stream needs 1080p.
func (n *Native) CaptureSized(id, maxWidth int) (im image.Image, err error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
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
	width, height := d.Width, d.Height
	if maxWidth < 1 {
		return nil, fmt.Errorf("invalid capture width")
	}
	if width > maxWidth {
		width = maxWidth
		height = max(1, d.Height*width/d.Width)
	}
	dc := win.GetDC(0)
	if dc == 0 {
		return nil, fmt.Errorf("GetDC failed")
	}
	defer win.ReleaseDC(0, dc)
	memory := win.CreateCompatibleDC(dc)
	if memory == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC failed")
	}
	defer win.DeleteDC(memory)
	header := win.BITMAPINFOHEADER{BiSize: uint32(unsafe.Sizeof(win.BITMAPINFOHEADER{})), BiWidth: int32(width), BiHeight: -int32(height), BiPlanes: 1, BiBitCount: 32, BiCompression: win.BI_RGB}
	var pixels unsafe.Pointer
	bitmap := win.CreateDIBSection(dc, &header, win.DIB_RGB_COLORS, &pixels, 0, 0)
	if bitmap == 0 || pixels == nil {
		return nil, fmt.Errorf("CreateDIBSection failed")
	}
	defer win.DeleteObject(win.HGDIOBJ(bitmap))
	old := win.SelectObject(memory, win.HGDIOBJ(bitmap))
	if old == 0 {
		return nil, fmt.Errorf("SelectObject failed")
	}
	defer win.SelectObject(memory, old)
	win.SetStretchBltMode(memory, win.COLORONCOLOR)
	if !win.StretchBlt(memory, 0, 0, int32(width), int32(height), dc, int32(d.X), int32(d.Y), int32(d.Width), int32(d.Height), win.SRCCOPY) {
		return nil, fmt.Errorf("screen copy failed")
	}
	if !win.GdiFlush() {
		return nil, fmt.Errorf("screen copy flush failed")
	}
	result := image.NewRGBA(image.Rect(0, 0, width, height))
	src := unsafe.Slice((*byte)(pixels), len(result.Pix))
	for i := 0; i < len(src); i += 4 {
		result.Pix[i], result.Pix[i+1], result.Pix[i+2], result.Pix[i+3] = src[i+2], src[i+1], src[i], 255
	}
	return result, nil
}
