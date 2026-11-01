// Package platform provides the small OS-specific capture/input boundary. It
// contains no networking and never starts itself in the background.
package platform

import (
	"errors"
	"fmt"
	"image"
	"image/color"
	"sync"
)

type Display struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
}

type Capabilities struct {
	Capture bool `json:"capture"`
	Input   bool `json:"input"`
}

// Coordinates are display-relative, in the same units as Display.Width/Height.
type InputEvent struct {
	Type      string `json:"type"`
	X         int    `json:"x,omitempty"`
	Y         int    `json:"y,omitempty"`
	DisplayID int    `json:"displayId,omitempty"`
	Button    string `json:"button,omitempty"`
	Code      string `json:"code,omitempty"`
	Down      bool   `json:"down,omitempty"`
	DeltaX    int    `json:"deltaX,omitempty"`
	DeltaY    int    `json:"deltaY,omitempty"`
}

type Backend interface {
	Capabilities() Capabilities
	Displays() ([]Display, error)
	Capture(displayID int) (image.Image, error)
	Input(InputEvent) error
}

func ValidateEvent(e InputEvent, displays []Display) error {
	switch e.Type {
	case "move":
		for _, d := range displays {
			if e.DisplayID == d.ID {
				if e.X < 0 || e.Y < 0 || e.X >= d.Width || e.Y >= d.Height {
					return errors.New("pointer outside display")
				}
				return nil
			}
		}
		return errors.New("unknown display")
	case "button":
		if e.Button != "left" && e.Button != "right" && e.Button != "middle" {
			return errors.New("unsupported button")
		}
	case "key":
		if !validKey(e.Code) {
			return errors.New("unsupported keyboard code")
		}
	case "scroll":
		if e.DeltaX < -1200 || e.DeltaX > 1200 || e.DeltaY < -1200 || e.DeltaY > 1200 {
			return errors.New("scroll delta out of range")
		}
	case "releaseAll":
	default:
		return errors.New("unsupported input type")
	}
	return nil
}

func validKey(code string) bool {
	if len(code) == 4 && code[:3] == "Key" && code[3] >= 'A' && code[3] <= 'Z' {
		return true
	}
	if len(code) == 6 && code[:5] == "Digit" && code[5] >= '0' && code[5] <= '9' {
		return true
	}
	for _, k := range []string{"Enter", "Escape", "Backspace", "Tab", "Space", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash", "CapsLock", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Delete", "Insert", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"} {
		if k == code {
			return true
		}
	}
	return false
}

// Synthetic is a deterministic test desktop. It never reads the actual screen
// or calls an operating system input API.
type Synthetic struct {
	mu        sync.Mutex
	events    []InputEvent
	clipboard string
}

func NewSynthetic() *Synthetic                { return &Synthetic{} }
func (*Synthetic) Capabilities() Capabilities { return Capabilities{true, true} }
func (*Synthetic) Displays() ([]Display, error) {
	return []Display{{0, "Synthetic display", 1280, 720, 0, 0}}, nil
}
func (*Synthetic) Capture(id int) (image.Image, error) {
	if id != 0 {
		return nil, errors.New("unknown display")
	}
	im := image.NewRGBA(image.Rect(0, 0, 1280, 720))
	for y := 0; y < 720; y++ {
		for x := 0; x < 1280; x++ {
			c := color.RGBA{18, 22, 29, 255}
			if x > 48 && x < 1232 && y > 56 && y < 664 {
				c = color.RGBA{27, 34, 44, 255}
			}
			if x > 80 && x < 1200 && y > 90 && y < 140 {
				c = color.RGBA{52, 76, 101, 255}
			}
			if x > 80 && x < 390 && y > 180 && y < 610 {
				c = color.RGBA{38, 48, 61, 255}
			}
			if x > 430 && x < 1190 && y > 180 && y < 610 {
				c = color.RGBA{uint8(40 + (x-430)/12), uint8(70 + (y-180)/8), 110, 255}
			}
			im.SetRGBA(x, y, c)
		}
	}
	return im, nil
}
func (s *Synthetic) Input(e InputEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.events) == 1024 {
		s.events = s.events[1:]
	}
	s.events = append(s.events, e)
	return nil
}
func (s *Synthetic) Events() []InputEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]InputEvent(nil), s.events...)
}

func DisplayBounds(displays []Display, id int) (Display, error) {
	for _, d := range displays {
		if d.ID == id {
			return d, nil
		}
	}
	return Display{}, fmt.Errorf("unknown display %d", id)
}
