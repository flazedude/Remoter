//go:build windows || (darwin && cgo)

package platform

type Native struct {
	keys    map[string]bool
	buttons map[string]bool
}

func NewNative() Backend {
	initializeNative()
	return &Native{keys: map[string]bool{}, buttons: map[string]bool{}}
}
func (*Native) Capabilities() Capabilities { return nativeCapabilities() }
