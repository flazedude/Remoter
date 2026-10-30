//go:build darwin && cgo

package platform

/*
#cgo CFLAGS: -x objective-c -fblocks -mmacosx-version-min=15.0
#cgo LDFLAGS: -framework ScreenCaptureKit -framework CoreGraphics -framework Foundation
#include <ScreenCaptureKit/ScreenCaptureKit.h>
#include <CoreGraphics/CoreGraphics.h>
#include <pthread.h>
#include <stdlib.h>

// A separate reference is held by the caller and completion block. A timed-out
// caller can leave immediately while a late OS callback still cleans up safely.
typedef struct {
    pthread_mutex_t lock;
    dispatch_semaphore_t semaphore;
    int references;
    CGImageRef image;
} RemoterCapture;

static void remoter_release_capture(RemoterCapture *state) {
    pthread_mutex_lock(&state->lock);
    int remaining = --state->references;
    pthread_mutex_unlock(&state->lock);
    if (remaining == 0) {
        if (state->image) CGImageRelease(state->image);
        dispatch_release(state->semaphore);
        pthread_mutex_destroy(&state->lock);
        free(state);
    }
}
static void remoter_complete_capture(RemoterCapture *state, CGImageRef image) {
    pthread_mutex_lock(&state->lock);
    state->image = image ? CGImageRetain(image) : NULL;
    pthread_mutex_unlock(&state->lock);
    dispatch_semaphore_signal(state->semaphore);
    remoter_release_capture(state);
}

static unsigned char *remoter_capture_display(CGDirectDisplayID displayID, int width, int height) {
    @autoreleasepool {
        RemoterCapture *state = calloc(1, sizeof(RemoterCapture));
        if (!state) return NULL;
        pthread_mutex_init(&state->lock, NULL);
        state->references = 2;
        state->semaphore = dispatch_semaphore_create(0);
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
            @autoreleasepool {
                if (error || !content) { remoter_complete_capture(state, NULL); return; }
                SCDisplay *target = nil;
                for (SCDisplay *display in content.displays) {
                    if (display.displayID == displayID) { target = display; break; }
                }
                if (!target) { remoter_complete_capture(state, NULL); return; }
                SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:target excludingWindows:@[]];
                SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
                config.width = width;
                config.height = height;
                config.showsCursor = YES;
                [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef image, NSError *captureError) {
                    remoter_complete_capture(state, captureError ? NULL : image);
                }];
                [config release];
                [filter release];
            }
        }];
        CGImageRef image = NULL;
        if (dispatch_semaphore_wait(state->semaphore, dispatch_time(DISPATCH_TIME_NOW, 10LL * NSEC_PER_SEC)) == 0) {
            pthread_mutex_lock(&state->lock);
            image = state->image;
            state->image = NULL;
            pthread_mutex_unlock(&state->lock);
        }
        remoter_release_capture(state);
        if (!image) return NULL;
        unsigned char *pixels = calloc((size_t)width * (size_t)height, 4);
        CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef context = pixels && color ? CGBitmapContextCreate(pixels, width, height, 8, (size_t)width * 4, color, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big) : NULL;
        if (context) {
            CGContextDrawImage(context, CGRectMake(0,0,width,height), image);
            CGContextRelease(context);
        } else {
            free(pixels);
            pixels = NULL;
        }
        if (color) CGColorSpaceRelease(color);
        CGImageRelease(image);
        return pixels;
    }
}
*/
import "C"

import (
	"fmt"
	"image"
	"unsafe"
)

func macDisplayIDs() ([]C.CGDirectDisplayID, error) {
	var count C.uint32_t
	if C.CGGetActiveDisplayList(0, nil, &count) != C.kCGErrorSuccess || count == 0 {
		return nil, fmt.Errorf("no active display; a logged-in desktop is required")
	}
	if count > 32 {
		return nil, fmt.Errorf("too many displays")
	}
	ids := make([]C.CGDirectDisplayID, int(count))
	if C.CGGetActiveDisplayList(count, &ids[0], &count) != C.kCGErrorSuccess {
		return nil, fmt.Errorf("cannot enumerate displays")
	}
	ids = ids[:int(count)]
	main := C.CGMainDisplayID()
	for i, id := range ids {
		if id == main {
			ids[0], ids[i] = ids[i], ids[0]
			break
		}
	}
	return ids, nil
}
func (*Native) Displays() ([]Display, error) {
	ids, err := macDisplayIDs()
	if err != nil {
		return nil, err
	}
	ds := make([]Display, 0, len(ids))
	for i, id := range ids {
		b := C.CGDisplayBounds(id)
		ds = append(ds, Display{i, fmt.Sprintf("Display %d", i+1), int(b.size.width), int(b.size.height), int(b.origin.x), int(b.origin.y)})
	}
	return ds, nil
}
func (n *Native) Capture(id int) (image.Image, error) {
	if !n.Capabilities().Capture {
		return nil, fmt.Errorf("grant Screen Recording permission in System Settings, then restart sharing")
	}
	ids, err := macDisplayIDs()
	if err != nil {
		return nil, err
	}
	if id < 0 || id >= len(ids) {
		return nil, fmt.Errorf("unknown display")
	}
	b := C.CGDisplayBounds(ids[id])
	width, height := int(b.size.width), int(b.size.height)
	if width <= 0 || height <= 0 || width > 16384 || height > 16384 || int64(width)*int64(height) > 40000000 {
		return nil, fmt.Errorf("display exceeds capture limit")
	}
	pixels := C.remoter_capture_display(ids[id], C.int(width), C.int(height))
	if pixels == nil {
		return nil, fmt.Errorf("screen capture unavailable or timed out; check Screen Recording permission and login state")
	}
	defer C.free(unsafe.Pointer(pixels))
	return &image.RGBA{Pix: C.GoBytes(unsafe.Pointer(pixels), C.int(width*height*4)), Stride: width * 4, Rect: image.Rect(0, 0, width, height)}, nil
}
