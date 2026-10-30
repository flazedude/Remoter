//go:build darwin && cgo

package platform

/*
#cgo LDFLAGS: -framework ApplicationServices -framework CoreGraphics
#include <ApplicationServices/ApplicationServices.h>
static int remoter_input(int kind, int x, int y, int key, int down, int dx, int dy, unsigned long long flags) {
    CGEventRef event = NULL;
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    if (!source) return 0;
    if (kind == 0) {
        CGEventType type = down ? (key == 0 ? kCGEventLeftMouseDragged : key == 1 ? kCGEventRightMouseDragged : kCGEventOtherMouseDragged) : kCGEventMouseMoved;
        CGMouseButton button = key == 0 ? kCGMouseButtonLeft : key == 1 ? kCGMouseButtonRight : kCGMouseButtonCenter;
        event = CGEventCreateMouseEvent(source, type, CGPointMake(x,y), button);
    } else if (kind == 1) {
        CGEventRef current = CGEventCreate(NULL);
        if (!current) { CFRelease(source); return 0; }
        CGPoint point = CGEventGetLocation(current);
        CFRelease(current);
        CGMouseButton button = key == 0 ? kCGMouseButtonLeft : key == 1 ? kCGMouseButtonRight : kCGMouseButtonCenter;
        CGEventType type = key == 0 ? (down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp) : key == 1 ? (down ? kCGEventRightMouseDown : kCGEventRightMouseUp) : (down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp);
        event = CGEventCreateMouseEvent(source, type, point, button);
    } else if (kind == 2) {
        event = CGEventCreateKeyboardEvent(source, (CGKeyCode)key, down);
    } else if (kind == 3) {
        event = CGEventCreateScrollWheelEvent(source, kCGScrollEventUnitPixel, 2, -dy, -dx);
    }
    if (!event) { CFRelease(source); return 0; }
    CGEventSetFlags(event, (CGEventFlags)flags);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    CFRelease(source);
    return 1;
}
*/
import "C"
import "fmt"

func initializeNative() {}
func nativeCapabilities() Capabilities {
	return Capabilities{bool(C.CGPreflightScreenCaptureAccess()), bool(C.AXIsProcessTrusted())}
}
func (n *Native) Input(e InputEvent) error {
	if e.Type == "releaseAll" {
		return nil
	}
	if !bool(C.AXIsProcessTrusted()) {
		return fmt.Errorf("Accessibility permission is required")
	}
	kind, x, y, key, down := 0, e.X, e.Y, 0, 0
	if e.Down {
		down = 1
	}
	switch e.Type {
	case "move":
		ds, err := n.Displays()
		if err != nil {
			return err
		}
		d, err := DisplayBounds(ds, e.DisplayID)
		if err != nil {
			return err
		}
		x += d.X
		y += d.Y
		for i, b := range []string{"left", "right", "middle"} {
			if n.buttons[b] {
				key = i
				down = 1
				break
			}
		}
	case "button":
		kind = 1
		switch e.Button {
		case "left":
			key = 0
		case "right":
			key = 1
		case "middle":
			key = 2
		default:
			return fmt.Errorf("unsupported button")
		}
	case "key":
		kind = 2
		var ok bool
		key, ok = macKeys[e.Code]
		if !ok {
			return fmt.Errorf("unsupported key")
		}
	case "scroll":
		kind = 3
	default:
		return fmt.Errorf("unsupported input type")
	}
	if n.keys == nil {
		n.keys = map[string]bool{}
	}
	if n.buttons == nil {
		n.buttons = map[string]bool{}
	}
	wasDown := n.keys[e.Code]
	if e.Type == "key" {
		n.keys[e.Code] = e.Down
	}
	var flags uint64
	if n.keys["ShiftLeft"] || n.keys["ShiftRight"] {
		flags |= 1 << 17
	}
	if n.keys["ControlLeft"] || n.keys["ControlRight"] {
		flags |= 1 << 18
	}
	if n.keys["AltLeft"] || n.keys["AltRight"] {
		flags |= 1 << 19
	}
	if n.keys["MetaLeft"] || n.keys["MetaRight"] {
		flags |= 1 << 20
	}
	if C.remoter_input(C.int(kind), C.int(x), C.int(y), C.int(key), C.int(down), C.int(e.DeltaX), C.int(e.DeltaY), C.ulonglong(flags)) == 0 {
		if e.Type == "key" {
			n.keys[e.Code] = wasDown
		}
		return fmt.Errorf("macOS rejected input")
	}
	if e.Type == "button" {
		n.buttons[e.Button] = e.Down
	}
	return nil
}

var macKeys = map[string]int{"KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17, "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25, "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53, "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57, "AltLeft": 58, "ControlLeft": 59, "ShiftRight": 60, "AltRight": 61, "ControlRight": 62, "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111, "Insert": 114, "Home": 115, "PageUp": 116, "Delete": 117, "End": 119, "PageDown": 121, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126}
