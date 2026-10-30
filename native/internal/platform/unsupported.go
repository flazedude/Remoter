//go:build (!windows && !darwin) || (darwin && !cgo)

package platform

import (
	"errors"
	"image"
)

type unsupported struct{}

func NewNative() Backend                          { return &unsupported{} }
func (*unsupported) Capabilities() Capabilities   { return Capabilities{} }
func (*unsupported) Displays() ([]Display, error) { return []Display{}, nil }
func (*unsupported) Capture(int) (image.Image, error) {
	return nil, errors.New("native capture requires Windows or macOS with CGO")
}
func (*unsupported) Input(InputEvent) error {
	return errors.New("native input unavailable on this build")
}
