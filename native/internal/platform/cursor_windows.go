//go:build windows

package platform

import (
	"image"
	"math"
	"unsafe"

	"github.com/lxn/win"
)

var (
	getCursorInfo  = user32.NewProc("GetCursorInfo")
	copyCursorIcon = user32.NewProc("CopyIcon")
)

type capturedCursor struct {
	Size, Flags uint32
	Handle      win.HICON
	Position    win.POINT
}

func drawCapturedCursor(dc win.HDC, display Display, width, height int) {
	cursor := capturedCursor{Size: uint32(unsafe.Sizeof(capturedCursor{}))}
	if ok, _, _ := getCursorInfo.Call(uintptr(unsafe.Pointer(&cursor))); ok != 0 {
		compositeCursor(dc, display, width, height, cursor)
	}
}

// GDI screen copies omit the OS cursor. Draw a snapshot of its current shape
// into the captured bitmap, accounting for its hotspot and capture scaling.
// Cursor lookup/drawing is best effort so a disappearing cursor cannot stop video.
func compositeCursor(dc win.HDC, display Display, width, height int, cursor capturedCursor) {
	const cursorShowing = 1
	if cursor.Flags != cursorShowing || cursor.Handle == 0 {
		return
	}
	copy, _, _ := copyCursorIcon.Call(uintptr(cursor.Handle))
	if copy == 0 {
		return
	}
	icon := win.HICON(copy)
	defer win.DestroyIcon(icon)
	var info win.ICONINFO
	if !win.GetIconInfo(icon, &info) {
		return
	}
	if info.HbmColor != 0 {
		defer win.DeleteObject(win.HGDIOBJ(info.HbmColor))
	}
	if info.HbmMask != 0 {
		defer win.DeleteObject(win.HGDIOBJ(info.HbmMask))
	}
	bitmap := info.HbmColor
	if bitmap == 0 {
		bitmap = info.HbmMask
	}
	var size win.BITMAP
	if win.GetObject(win.HGDIOBJ(bitmap), unsafe.Sizeof(size), unsafe.Pointer(&size)) == 0 {
		return
	}
	if info.HbmColor == 0 {
		// Monochrome cursor masks stack the AND and XOR planes vertically.
		size.BmHeight /= 2
	}
	bounds := cursorBounds(display, width, height, cursor.Position, info, int(size.BmWidth), int(size.BmHeight))
	if bounds.Empty() || !bounds.Overlaps(image.Rect(0, 0, width, height)) {
		return
	}
	win.DrawIconEx(dc, int32(bounds.Min.X), int32(bounds.Min.Y), icon, int32(bounds.Dx()), int32(bounds.Dy()), 0, 0, win.DI_NORMAL)
}

func cursorBounds(display Display, width, height int, position win.POINT, info win.ICONINFO, iconWidth, iconHeight int) image.Rectangle {
	if display.Width <= 0 || display.Height <= 0 || width <= 0 || height <= 0 || iconWidth <= 0 || iconHeight <= 0 {
		return image.Rectangle{}
	}
	x := int(math.Floor(float64(int(position.X)-display.X-int(info.XHotspot)) * float64(width) / float64(display.Width)))
	y := int(math.Floor(float64(int(position.Y)-display.Y-int(info.YHotspot)) * float64(height) / float64(display.Height)))
	w := max(1, iconWidth*width/display.Width)
	h := max(1, iconHeight*height/display.Height)
	return image.Rect(x, y, x+w, y+h)
}
