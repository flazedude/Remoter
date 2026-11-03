//go:build darwin && cgo

package platform

/*
#cgo CFLAGS: -x objective-c -fblocks -mmacosx-version-min=15.0
#cgo LDFLAGS: -framework ScreenCaptureKit -framework CoreGraphics -framework Foundation -framework CoreMedia -framework CoreVideo -framework Accelerate
#include <ScreenCaptureKit/ScreenCaptureKit.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <Accelerate/Accelerate.h>
#include <pthread.h>
#include <stdlib.h>

// SCStream stays alive across frames. Store only the newest surface: the OS
// recycles old surfaces immediately, even when a client or JPEG encoder is slow.
@interface RemoterScreen : NSObject <SCStreamOutput, SCStreamDelegate> {
@public
    pthread_mutex_t lock;
    dispatch_semaphore_t ready;
    SCStream *stream;
    CVPixelBufferRef latest;
    BOOL failed;
    BOOL cancelled;
    uint64_t generation;
}
@end
@implementation RemoterScreen
- (id)init {
    if ((self = [super init])) { pthread_mutex_init(&lock, NULL); ready = dispatch_semaphore_create(0); }
    return self;
}
- (void)stream:(SCStream *)source didStopWithError:(NSError *)error {
    pthread_mutex_lock(&lock); failed = YES; pthread_mutex_unlock(&lock);
    dispatch_semaphore_signal(ready);
}
- (void)stream:(SCStream *)source didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (!attachments || CFArrayGetCount(attachments) == 0) return;
    NSDictionary *info = (NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    if ([info[SCStreamFrameInfoStatus] integerValue] != SCFrameStatusComplete) return;
    CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
    if (!pixels) return;
    CVPixelBufferRetain(pixels);
    pthread_mutex_lock(&lock);
    CVPixelBufferRef old = latest; latest = pixels;
    pthread_mutex_unlock(&lock);
    if (old) CVPixelBufferRelease(old);
    // A binary readiness signal, rather than one queued signal per frame.
    if (!old) dispatch_semaphore_signal(ready);
}
- (void)dealloc {
    if (latest) CVPixelBufferRelease(latest);
    [stream release]; dispatch_release(ready); pthread_mutex_destroy(&lock);
    [super dealloc];
}
@end

static pthread_mutex_t remoter_stream_lock = PTHREAD_MUTEX_INITIALIZER;
static RemoterScreen *remoter_screen;
static CGDirectDisplayID remoter_display;
static int remoter_width, remoter_height;

// Caller holds the global lock. Output callbacks use the object's own lock.
static void remoter_stop_screen(void) {
    if (!remoter_screen) return;
    pthread_mutex_lock(&remoter_screen->lock); remoter_screen->cancelled = YES; pthread_mutex_unlock(&remoter_screen->lock);
    [remoter_screen->stream stopCaptureWithCompletionHandler:^(NSError *error) {}];
    [remoter_screen->stream removeStreamOutput:remoter_screen type:SCStreamOutputTypeScreen error:NULL];
    [remoter_screen release]; remoter_screen = nil;
}
static unsigned char *remoter_capture_display(CGDirectDisplayID displayID, int width, int height) {
    @autoreleasepool {
        pthread_mutex_lock(&remoter_stream_lock);
        if (remoter_screen) {
            pthread_mutex_lock(&remoter_screen->lock); BOOL failed = remoter_screen->failed; pthread_mutex_unlock(&remoter_screen->lock);
            if (failed || remoter_display != displayID || remoter_width != width || remoter_height != height) remoter_stop_screen();
        }
        if (!remoter_screen) {
            RemoterScreen *screen = [[RemoterScreen alloc] init];
            remoter_screen = screen; remoter_display = displayID; remoter_width = width; remoter_height = height;
            [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
                @autoreleasepool {
                    pthread_mutex_lock(&screen->lock);
                    if (screen->cancelled) { pthread_mutex_unlock(&screen->lock); return; }
                    SCDisplay *target = nil;
                    if (!error) for (SCDisplay *display in content.displays) if (display.displayID == displayID) { target = display; break; }
                    if (!target) { pthread_mutex_unlock(&screen->lock); [screen stream:screen->stream didStopWithError:error]; return; }
                    SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:target excludingWindows:@[]];
                    SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
                    config.width = width; config.height = height;
                    config.minimumFrameInterval = CMTimeMake(1, 30);
                    config.queueDepth = 3; config.showsCursor = YES;
                    config.pixelFormat = kCVPixelFormatType_32BGRA;
                    config.colorSpaceName = kCGColorSpaceSRGB;
                    screen->stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:screen];
                    pthread_mutex_unlock(&screen->lock);
                    NSError *outputError = nil;
                    if (![screen->stream addStreamOutput:screen type:SCStreamOutputTypeScreen sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0) error:&outputError]) {
                        [screen stream:screen->stream didStopWithError:outputError];
                    } else {
                        [screen->stream startCaptureWithCompletionHandler:^(NSError *startError) {
                            pthread_mutex_lock(&screen->lock); BOOL cancelled = screen->cancelled; pthread_mutex_unlock(&screen->lock);
                            if (cancelled) {
                                [screen->stream stopCaptureWithCompletionHandler:^(NSError *error) {}];
                                [screen->stream removeStreamOutput:screen type:SCStreamOutputTypeScreen error:NULL];
                            } else if (startError) [screen stream:screen->stream didStopWithError:startError];
                        }];
                    }
                    [config release]; [filter release];
                }
            }];
            // Late completion blocks retain screen safely after a timeout.
            dispatch_semaphore_wait(screen->ready, dispatch_time(DISPATCH_TIME_NOW, 10LL*NSEC_PER_SEC));
        }
        RemoterScreen *screen = remoter_screen;
        pthread_mutex_lock(&screen->lock);
        CVPixelBufferRef frame = screen->failed ? NULL : screen->latest;
        if (frame) CVPixelBufferRetain(frame);
        pthread_mutex_unlock(&screen->lock);
        uint64_t generation = ++screen->generation;
        // Stop the OS capture promptly if sharing is paused or disconnected.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            pthread_mutex_lock(&remoter_stream_lock);
            if (remoter_screen == screen && screen->generation == generation) remoter_stop_screen();
            pthread_mutex_unlock(&remoter_stream_lock);
        });
        pthread_mutex_unlock(&remoter_stream_lock);
        if (!frame) return NULL;
        unsigned char *pixels = calloc((size_t)width * height, 4);
        if (pixels && CVPixelBufferGetWidth(frame) == width && CVPixelBufferGetHeight(frame) == height && CVPixelBufferLockBaseAddress(frame, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess) {
            vImage_Buffer src = { CVPixelBufferGetBaseAddress(frame), height, width, CVPixelBufferGetBytesPerRow(frame) };
            vImage_Buffer dst = { pixels, height, width, (size_t)width * 4 };
            const uint8_t permute[] = { 2, 1, 0, 3 };
            vImage_Error result = vImagePermuteChannels_ARGB8888(&src, &dst, permute, kvImageNoFlags);
            CVPixelBufferUnlockBaseAddress(frame, kCVPixelBufferLock_ReadOnly);
            if (result != kvImageNoError) { free(pixels); pixels = NULL; }
        } else { free(pixels); pixels = NULL; }
        CVPixelBufferRelease(frame);
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
	return n.CaptureSized(id, 16384)
}
func (n *Native) CaptureSized(id, maxWidth int) (image.Image, error) {
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
	if maxWidth < 1 {
		return nil, fmt.Errorf("invalid capture width")
	}
	if width > maxWidth {
		height = max(1, height*maxWidth/width)
		width = maxWidth
	}
	pixels := C.remoter_capture_display(ids[id], C.int(width), C.int(height))
	if pixels == nil {
		return nil, fmt.Errorf("screen capture unavailable or timed out; check Screen Recording permission and login state")
	}
	defer C.free(unsafe.Pointer(pixels))
	return &image.RGBA{Pix: C.GoBytes(unsafe.Pointer(pixels), C.int(width*height*4)), Stride: width * 4, Rect: image.Rect(0, 0, width, height)}, nil
}
