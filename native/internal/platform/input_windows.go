//go:build windows

package platform

import (
	"encoding/binary"
	"fmt"
	"syscall"
	"unsafe"
)

var user32 = syscall.NewLazyDLL("user32.dll")
var sendInput = user32.NewProc("SendInput")
var setCursorPos = user32.NewProc("SetCursorPos")

func initializeNative()                { user32.NewProc("SetProcessDPIAware").Call() }
func nativeCapabilities() Capabilities { return Capabilities{true, true} }

func (*Native) Input(e InputEvent) error {
	if e.Type == "releaseAll" {
		return nil
	} // Host tracks and releases only its own held inputs.
	if e.Type == "move" {
		ds, err := (&Native{}).Displays()
		if err != nil {
			return err
		}
		d, err := DisplayBounds(ds, e.DisplayID)
		if err != nil {
			return err
		}
		r, _, err := setCursorPos.Call(uintptr(d.X+e.X), uintptr(d.Y+e.Y))
		if r == 0 {
			return fmt.Errorf("pointer move failed: %v", err)
		}
		return nil
	}
	base, size := 4, 28
	if unsafe.Sizeof(uintptr(0)) == 8 {
		base, size = 8, 40
	}
	b := make([]byte, size)
	switch e.Type {
	case "button":
		var flags uint32
		switch e.Button {
		case "left":
			flags = 2
		case "right":
			flags = 8
		case "middle":
			flags = 32
		default:
			return fmt.Errorf("unsupported button")
		}
		if !e.Down {
			flags *= 2
		}
		binary.LittleEndian.PutUint32(b[base+12:], flags)
	case "scroll":
		// DOM deltas point down/right; Windows wheel values point up/right.
		if e.DeltaY != 0 {
			binary.LittleEndian.PutUint32(b[base+8:], uint32(int32(-e.DeltaY)))
			binary.LittleEndian.PutUint32(b[base+12:], 0x0800)
			if err := sendWinInput(b); err != nil {
				return err
			}
		}
		if e.DeltaX == 0 {
			return nil
		}
		binary.LittleEndian.PutUint32(b[base+8:], uint32(int32(e.DeltaX)))
		binary.LittleEndian.PutUint32(b[base+12:], 0x1000)
	case "key":
		vk, extended, ok := windowsKey(e.Code)
		if !ok {
			return fmt.Errorf("unsupported key")
		}
		binary.LittleEndian.PutUint32(b, 1)
		binary.LittleEndian.PutUint16(b[base:], vk)
		var flags uint32
		if !e.Down {
			flags |= 2
		}
		if extended {
			flags |= 1
		}
		binary.LittleEndian.PutUint32(b[base+4:], flags)
	default:
		return fmt.Errorf("unsupported input type")
	}
	return sendWinInput(b)
}
func sendWinInput(b []byte) error {
	r, _, err := sendInput.Call(1, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)))
	if r != 1 {
		return fmt.Errorf("input rejected by Windows (elevation or desktop permissions): %v", err)
	}
	return nil
}
func windowsKey(code string) (uint16, bool, bool) {
	if len(code) == 4 && code[:3] == "Key" && code[3] >= 'A' && code[3] <= 'Z' {
		return uint16(code[3]), false, true
	}
	if len(code) == 6 && code[:5] == "Digit" && code[5] >= '0' && code[5] <= '9' {
		return uint16(code[5]), false, true
	}
	m := map[string]uint16{"Enter": 13, "Escape": 27, "Backspace": 8, "Tab": 9, "Space": 32, "Minus": 0xBD, "Equal": 0xBB, "BracketLeft": 0xDB, "BracketRight": 0xDD, "Backslash": 0xDC, "Semicolon": 0xBA, "Quote": 0xDE, "Backquote": 0xC0, "Comma": 0xBC, "Period": 0xBE, "Slash": 0xBF, "CapsLock": 0x14, "ShiftLeft": 0xA0, "ShiftRight": 0xA1, "ControlLeft": 0xA2, "ControlRight": 0xA3, "AltLeft": 0xA4, "AltRight": 0xA5, "MetaLeft": 0x5B, "MetaRight": 0x5C, "ArrowUp": 0x26, "ArrowDown": 0x28, "ArrowLeft": 0x25, "ArrowRight": 0x27, "Home": 0x24, "End": 0x23, "PageUp": 0x21, "PageDown": 0x22, "Delete": 0x2E, "Insert": 0x2D, "F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73, "F5": 0x74, "F6": 0x75, "F7": 0x76, "F8": 0x77, "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B}
	v, ok := m[code]
	extended := code == "ControlRight" || code == "AltRight" || code == "MetaLeft" || code == "MetaRight" || code == "ArrowUp" || code == "ArrowDown" || code == "ArrowLeft" || code == "ArrowRight" || code == "Home" || code == "End" || code == "PageUp" || code == "PageDown" || code == "Delete" || code == "Insert"
	return v, extended, ok
}
