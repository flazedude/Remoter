//go:build darwin && cgo

package platform

/*
#cgo LDFLAGS: -framework ApplicationServices -framework CoreGraphics
#include <ApplicationServices/ApplicationServices.h>
static void remoter_request_input_permission(void) {
    const void *keys[] = { kAXTrustedCheckOptionPrompt };
    const void *values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
}
*/
import "C"

import "fmt"

// RequestPermission is called only after an explicit local setup action. It
// does not capture pixels, inject input, create an identity, or open a listener.
func RequestPermission(permission string) error {
	switch permission {
	case "screen":
		C.CGRequestScreenCaptureAccess()
	case "input":
		C.remoter_request_input_permission()
	default:
		return fmt.Errorf("unknown macOS permission")
	}
	return nil
}
