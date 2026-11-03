//go:build windows

package platform

import (
	"image"
	"runtime"
	"testing"
	"unsafe"

	"github.com/lxn/win"
)

// These tests draw generated cursors into an in-memory bitmap. They neither
// capture the desktop nor move/change the user's cursor.
func TestCursorComposition(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	const width, height = 100, 50
	dc := win.CreateCompatibleDC(0)
	if dc == 0 {
		t.Fatal("CreateCompatibleDC failed")
	}
	defer win.DeleteDC(dc)
	bitmap, pixels := cursorTestBitmap(t, width, height)
	defer win.DeleteObject(win.HGDIOBJ(bitmap))
	previous := win.SelectObject(dc, win.HGDIOBJ(bitmap))
	if previous == 0 {
		t.Fatal("SelectObject failed")
	}
	defer win.SelectObject(dc, previous)
	display := Display{X: -200, Y: -100, Width: 200, Height: 100}
	for _, monochrome := range []bool{false, true} {
		icon := cursorTestIcon(t, monochrome)
		defer win.DestroyIcon(icon)
		for _, test := range []struct {
			name     string
			flags    uint32
			position win.POINT
			want     image.Rectangle
		}{
			{"scaled hotspot on negative-origin monitor", 1, win.POINT{X: -156, Y: -76}, image.Rect(20, 10, 28, 18)},
			{"partially clipped left and top", 1, win.POINT{X: -200, Y: -100}, image.Rect(0, 0, 6, 6)},
			{"partially clipped right and bottom", 1, win.POINT{X: 0, Y: 0}, image.Rect(98, 48, 100, 50)},
			{"on another monitor", 1, win.POINT{X: 200, Y: 100}, image.Rectangle{}},
			{"hidden", 0, win.POINT{X: -156, Y: -76}, image.Rectangle{}},
			{"suppressed by touch", 2, win.POINT{X: -156, Y: -76}, image.Rectangle{}},
		} {
			t.Run(test.name+map[bool]string{true: "/monochrome", false: "/color"}[monochrome], func(t *testing.T) {
				clear(pixels)
				compositeCursor(dc, display, width, height, capturedCursor{Flags: test.flags, Handle: icon, Position: test.position})
				if !win.GdiFlush() {
					t.Fatal("GdiFlush failed")
				}
				var actual image.Rectangle
				for y := 0; y < height; y++ {
					for x := 0; x < width; x++ {
						i := (y*width + x) * 4
						if pixels[i] != 0 || pixels[i+1] != 0 || pixels[i+2] != 0 {
							actual = actual.Union(image.Rect(x, y, x+1, y+1))
						}
					}
				}
				if actual != test.want {
					t.Fatalf("drawn pixels occupy %v, want %v", actual, test.want)
				}
			})
		}
	}
}

func TestCursorBounds(t *testing.T) {
	if got := cursorBounds(Display{}, 100, 50, win.POINT{}, win.ICONINFO{}, 16, 16); !got.Empty() {
		t.Fatalf("invalid display produced %v", got)
	}
	// Floor negative offsets so a hotspot just outside the display is clipped,
	// rather than rounded toward the first pixel inside it.
	got := cursorBounds(Display{Width: 300, Height: 300}, 100, 100, win.POINT{}, win.ICONINFO{XHotspot: 1, YHotspot: 1}, 16, 16)
	if want := image.Rect(-1, -1, 4, 4); got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func cursorTestBitmap(t *testing.T, width, height int) (win.HBITMAP, []byte) {
	t.Helper()
	header := win.BITMAPINFOHEADER{BiSize: uint32(unsafe.Sizeof(win.BITMAPINFOHEADER{})), BiWidth: int32(width), BiHeight: -int32(height), BiPlanes: 1, BiBitCount: 32, BiCompression: win.BI_RGB}
	var pixels unsafe.Pointer
	bitmap := win.CreateDIBSection(0, &header, win.DIB_RGB_COLORS, &pixels, 0, 0)
	if bitmap == 0 || pixels == nil {
		t.Fatal("CreateDIBSection failed")
	}
	return bitmap, unsafe.Slice((*byte)(pixels), width*height*4)
}

func cursorTestIcon(t *testing.T, monochrome bool) win.HICON {
	t.Helper()
	info := win.ICONINFO{XHotspot: 4, YHotspot: 4}
	maskHeight := 16
	if monochrome {
		maskHeight *= 2
	} else {
		var pixels []byte
		info.HbmColor, pixels = cursorTestBitmap(t, 16, 16)
		defer win.DeleteObject(win.HGDIOBJ(info.HbmColor))
		for i := 0; i < len(pixels); i += 4 {
			pixels[i+2], pixels[i+3] = 255, 255
		}
	}
	mask := make([]byte, 2*maskHeight)
	if monochrome {
		for i := 32; i < len(mask); i++ {
			mask[i] = 255
		}
	}
	info.HbmMask = win.CreateBitmap(16, int32(maskHeight), 1, 1, unsafe.Pointer(&mask[0]))
	if info.HbmMask == 0 {
		t.Fatal("CreateBitmap failed")
	}
	defer win.DeleteObject(win.HGDIOBJ(info.HbmMask))
	icon := win.CreateIconIndirect(&info)
	if icon == 0 {
		t.Fatal("CreateIconIndirect failed")
	}
	return icon
}
