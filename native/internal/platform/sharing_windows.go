//go:build windows

package platform

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/lxn/win"
	"github.com/moutend/go-wca/pkg/wca"
)

type desktopSharing struct{ mu sync.Mutex }

func SharingAvailable() bool { return true }
func NewSharing() Sharing    { return &desktopSharing{} }

var kernel32 = syscall.NewLazyDLL("kernel32.dll")

func (s *desktopSharing) withClipboard(fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	// A real owner window is required for EmptyClipboard/SetClipboardData.
	class, _ := syscall.UTF16PtrFromString("STATIC")
	hwnd, _, _ := user32.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class)), 0, 0, 0, 0, 0, 0, ^uintptr(2), 0, 0, 0)
	if hwnd == 0 {
		return errors.New("cannot create clipboard owner")
	}
	defer user32.NewProc("DestroyWindow").Call(hwnd)
	for i := 0; i < 10; i++ {
		if ok, _, _ := user32.NewProc("OpenClipboard").Call(hwnd); ok != 0 {
			defer user32.NewProc("CloseClipboard").Call()
			return fn()
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("clipboard is busy")
}
func (s *desktopSharing) ReadClipboard() (text string, err error) {
	err = s.withClipboard(func() error {
		h, _, _ := user32.NewProc("GetClipboardData").Call(13)
		if h == 0 {
			return nil
		}
		size, _, _ := kernel32.NewProc("GlobalSize").Call(h)
		if size > MaxClipboardBytes*2+2 {
			return errors.New("clipboard text exceeds 1 MiB")
		}
		p := win.GlobalLock(win.HGLOBAL(h))
		if p == nil {
			return errors.New("cannot read clipboard")
		}
		defer kernel32.NewProc("GlobalUnlock").Call(h)
		words := unsafe.Slice((*uint16)(p), int(size)/2)
		for i, word := range words {
			if word == 0 {
				words = words[:i]
				break
			}
		}
		text = string(utf16.Decode(words))
		if len(text) > MaxClipboardBytes {
			return errors.New("clipboard text exceeds 1 MiB")
		}
		return nil
	})
	return
}
func (s *desktopSharing) WriteClipboard(text string) error {
	if len(text) > MaxClipboardBytes || strings.ContainsRune(text, 0) {
		return errors.New("invalid clipboard text")
	}
	return s.withClipboard(func() error {
		words := append(utf16.Encode([]rune(text)), 0)
		h, _, _ := kernel32.NewProc("GlobalAlloc").Call(2, uintptr(len(words)*2))
		if h == 0 {
			return errors.New("cannot allocate clipboard")
		}
		owned := true
		defer func() {
			if owned {
				kernel32.NewProc("GlobalFree").Call(h)
			}
		}()
		p := win.GlobalLock(win.HGLOBAL(h))
		if p == nil {
			return errors.New("cannot lock clipboard")
		}
		copy(unsafe.Slice((*uint16)(p), len(words)), words)
		kernel32.NewProc("GlobalUnlock").Call(h)
		if ok, _, _ := user32.NewProc("EmptyClipboard").Call(); ok == 0 {
			return errors.New("cannot clear clipboard")
		}
		if ok, _, _ := user32.NewProc("SetClipboardData").Call(13, h); ok == 0 {
			return errors.New("cannot write clipboard")
		}
		owned = false
		return nil
	})
}

func (*desktopSharing) CaptureAudio(ctx context.Context, emit func([]byte)) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
		return err
	}
	defer ole.CoUninitialize()
	var enumerator *wca.IMMDeviceEnumerator
	if err := wca.CoCreateInstance(wca.CLSID_MMDeviceEnumerator, 0, ole.CLSCTX_ALL, wca.IID_IMMDeviceEnumerator, &enumerator); err != nil {
		return err
	}
	defer enumerator.Release()
	var device *wca.IMMDevice
	if err := enumerator.GetDefaultAudioEndpoint(wca.ERender, wca.EConsole, &device); err != nil {
		return fmt.Errorf("no default playback device: %w", err)
	}
	defer device.Release()
	var client *wca.IAudioClient
	if err := device.Activate(wca.IID_IAudioClient, ole.CLSCTX_ALL, nil, &client); err != nil {
		return err
	}
	defer client.Release()
	format := wca.WAVEFORMATEX{WFormatTag: 3, NChannels: 2, NSamplesPerSec: 48000, NAvgBytesPerSec: 384000, NBlockAlign: 8, WBitsPerSample: 32}
	// WASAPI performs channel and sample-rate conversion into a fixed wire format.
	if err := client.Initialize(wca.AUDCLNT_SHAREMODE_SHARED, wca.AUDCLNT_STREAMFLAGS_LOOPBACK|0x80000000|0x08000000, 1000000, 0, &format, nil); err != nil {
		return err
	}
	var capture *wca.IAudioCaptureClient
	if err := client.GetService(wca.IID_IAudioCaptureClient, &capture); err != nil {
		return err
	}
	defer capture.Release()
	if err := client.Start(); err != nil {
		return err
	}
	defer client.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	pending := make([]byte, 0, 19200)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		for {
			var frames uint32
			if err := capture.GetNextPacketSize(&frames); err != nil {
				return err
			}
			if frames == 0 {
				break
			}
			var data *byte
			var flags uint32
			if err := capture.GetBuffer(&data, &frames, &flags, nil, nil); err != nil {
				return err
			}
			if frames > 48000 {
				_ = capture.ReleaseBuffer(frames)
				return errors.New("invalid audio packet")
			}
			pcm := make([]byte, int(frames)*4)
			if flags&wca.AUDCLNT_BUFFERFLAGS_SILENT == 0 && data != nil {
				samples := unsafe.Slice((*float32)(unsafe.Pointer(data)), int(frames)*2)
				for i, sample := range samples {
					v := math.Max(-1, math.Min(1, float64(sample)))
					if math.IsNaN(v) {
						v = 0
					}
					binary.LittleEndian.PutUint16(pcm[i*2:], uint16(int16(v*32767)))
				}
			}
			if err := capture.ReleaseBuffer(frames); err != nil {
				return err
			}
			pending = append(pending, pcm...)
		}
		// 50 ms packets; avoid emitting artificial silence while the device is idle.
		for len(pending) >= 9600 {
			emit(append([]byte(nil), pending[:9600]...))
			pending = pending[9600:]
		}
	}
}
