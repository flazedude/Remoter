//go:build !darwin || !cgo

package platform

import "fmt"

func RequestPermission(string) error {
	return fmt.Errorf("permission requests require a macOS native host with CGO enabled")
}
