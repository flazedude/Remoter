//go:build windows && (amd64 || arm64)

package host

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	gdiplus            = windows.NewLazySystemDLL("gdiplus.dll")
	gdipStartup        = gdiplus.NewProc("GdiplusStartup")
	gdipCreate         = gdiplus.NewProc("GdipCreateBitmapFromScan0")
	gdipSave           = gdiplus.NewProc("GdipSaveImageToStream")
	gdipDispose        = gdiplus.NewProc("GdipDisposeImage")
	oleStreams         = windows.NewLazySystemDLL("ole32.dll")
	createMemoryStream = oleStreams.NewProc("CreateStreamOnHGlobal")
	getStreamMemory    = oleStreams.NewProc("GetHGlobalFromStream")
	jpegKernel         = windows.NewLazySystemDLL("kernel32.dll")
	jpegGlobalLock     = jpegKernel.NewProc("GlobalLock")
	jpegGlobalUnlock   = jpegKernel.NewProc("GlobalUnlock")
	jpegStartup        sync.Once
	jpegReady          bool
)

type encoderParameter struct {
	ID          windows.GUID
	Count, Kind uint32
	Value       uintptr
}
type encoderParameters struct {
	Count     uint32
	Parameter encoderParameter
}

// Use the Windows JPEG codec instead of spending most of a 33ms frame budget
// in the portable DCT encoder. No external DLLs or disk-backed image files.
func encodeJPEG(out *bytes.Buffer, im image.Image, quality int) error {
	rgba, ok := im.(*image.RGBA)
	if !ok {
		return jpeg.Encode(out, im, &jpeg.Options{Quality: quality})
	}
	jpegStartup.Do(func() {
		input := struct {
			Version                        uint32
			Callback                       uintptr
			SuppressThread, SuppressCodecs uint32
		}{Version: 1}
		var token uintptr
		status, _, _ := gdipStartup.Call(uintptr(unsafe.Pointer(&token)), uintptr(unsafe.Pointer(&input)), 0)
		jpegReady = status == 0
		// GDI+ lives until process exit, alongside the host capture backend.
	})
	if !jpegReady {
		return jpeg.Encode(out, im, &jpeg.Options{Quality: quality})
	}
	b := rgba.Bounds()
	stride := b.Dx() * 4
	bgra := make([]byte, stride*b.Dy())
	for y := 0; y < b.Dy(); y++ {
		src := rgba.Pix[rgba.PixOffset(b.Min.X, b.Min.Y+y):]
		dst := bgra[y*stride : (y+1)*stride]
		for x := 0; x < stride; x += 4 {
			dst[x], dst[x+1], dst[x+2], dst[x+3] = src[x+2], src[x+1], src[x], 255
		}
	}
	var bitmap uintptr
	status, _, _ := gdipCreate.Call(uintptr(b.Dx()), uintptr(b.Dy()), uintptr(stride), 0x26200a, uintptr(unsafe.Pointer(&bgra[0])), uintptr(unsafe.Pointer(&bitmap)))
	if status != 0 {
		return fmt.Errorf("native JPEG bitmap failed: %d", status)
	}
	defer func() { gdipDispose.Call(bitmap); runtime.KeepAlive(bgra) }()
	var stream uintptr
	hr, _, _ := createMemoryStream.Call(0, 1, uintptr(unsafe.Pointer(&stream)))
	if int32(hr) < 0 || stream == 0 {
		return fmt.Errorf("native JPEG stream failed")
	}
	vtable := *(*[14]uintptr)(unsafe.Pointer(*(*uintptr)(unsafe.Pointer(stream))))
	defer syscall.SyscallN(vtable[2], stream) // IUnknown::Release owns HGLOBAL.
	q := uint32(quality)
	params := encoderParameters{Count: 1, Parameter: encoderParameter{
		ID: windows.GUID{Data1: 0x1d5be4b5, Data2: 0xfa4a, Data3: 0x452d, Data4: [8]byte{0x9c, 0xdd, 0x5d, 0xb3, 0x51, 0x05, 0xe7, 0xeb}}, Count: 1, Kind: 4, Value: uintptr(unsafe.Pointer(&q)),
	}}
	encoder := windows.GUID{Data1: 0x557cf401, Data2: 0x1a04, Data3: 0x11d3, Data4: [8]byte{0x9a, 0x73, 0, 0, 0xf8, 0x1e, 0xf3, 0x2e}}
	status, _, _ = gdipSave.Call(bitmap, stream, uintptr(unsafe.Pointer(&encoder)), uintptr(unsafe.Pointer(&params)))
	runtime.KeepAlive(&q)
	if status != 0 {
		return fmt.Errorf("native JPEG encoding failed: %d", status)
	}
	var size uint64
	hr, _, _ = syscall.SyscallN(vtable[5], stream, 0, 2, uintptr(unsafe.Pointer(&size))) // IStream::Seek(END)
	if int32(hr) < 0 || size < 4 || size > 16*1024*1024 {
		return fmt.Errorf("invalid native JPEG size")
	}
	var memory uintptr
	hr, _, _ = getStreamMemory.Call(stream, uintptr(unsafe.Pointer(&memory)))
	if int32(hr) < 0 {
		return fmt.Errorf("native JPEG memory unavailable")
	}
	pixels, _, _ := jpegGlobalLock.Call(memory)
	if pixels == 0 {
		return fmt.Errorf("native JPEG memory lock failed")
	}
	out.Write(unsafe.Slice((*byte)(unsafe.Pointer(pixels)), int(size)))
	jpegGlobalUnlock.Call(memory)
	return nil
}
