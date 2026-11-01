//go:build !windows

package platform

import (
	"context"
	"errors"
)

func SharingAvailable() bool { return false }

type desktopSharing struct{}

func NewSharing() Sharing { return desktopSharing{} }
func (desktopSharing) ReadClipboard() (string, error) {
	return "", errors.New("clipboard sharing requires a Windows host")
}
func (desktopSharing) WriteClipboard(string) error {
	return errors.New("clipboard sharing requires a Windows host")
}
func (desktopSharing) CaptureAudio(context.Context, func([]byte)) error {
	return errors.New("system audio sharing requires a Windows host")
}
