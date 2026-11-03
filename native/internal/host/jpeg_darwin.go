//go:build darwin && cgo

package host

/*
#cgo LDFLAGS: -framework ImageIO -framework CoreGraphics -framework CoreFoundation
#include <ImageIO/ImageIO.h>
#include <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
static CFDataRef remoter_jpeg(unsigned char *pixels, int width, int height, int stride, int quality) {
 CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
 CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, pixels, (size_t)stride * height, NULL);
 CGImageRef image = CGImageCreate(width, height, 8, 32, stride, color, kCGImageAlphaNoneSkipLast | kCGBitmapByteOrder32Big, provider, NULL, false, kCGRenderingIntentDefault);
 CFMutableDataRef data = CFDataCreateMutable(NULL, 0);
 CGImageDestinationRef destination = image && data ? CGImageDestinationCreateWithData(data, CFSTR("public.jpeg"), 1, NULL) : NULL;
 double q = quality / 100.0;
 CFNumberRef number = CFNumberCreate(NULL, kCFNumberDoubleType, &q);
 const void *keys[] = { kCGImageDestinationLossyCompressionQuality };
 const void *values[] = { number };
 CFDictionaryRef properties = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
 bool ok = false;
 if (destination) { CGImageDestinationAddImage(destination, image, properties); ok = CGImageDestinationFinalize(destination); CFRelease(destination); }
 CFRelease(properties); CFRelease(number);
 if (image) CGImageRelease(image);
 CGDataProviderRelease(provider); CGColorSpaceRelease(color);
 if (!ok && data) { CFRelease(data); data = NULL; }
 return data;
}
*/
import "C"

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"runtime"
	"unsafe"
)

func encodeJPEG(out *bytes.Buffer, im image.Image, quality int) error {
	rgba, ok := im.(*image.RGBA)
	if !ok {
		return jpeg.Encode(out, im, &jpeg.Options{Quality: quality})
	}
	b := rgba.Bounds()
	pixels := rgba.Pix[rgba.PixOffset(b.Min.X, b.Min.Y):]
	data := C.remoter_jpeg((*C.uchar)(unsafe.Pointer(&pixels[0])), C.int(b.Dx()), C.int(b.Dy()), C.int(rgba.Stride), C.int(quality))
	runtime.KeepAlive(rgba)
	if data == 0 {
		return fmt.Errorf("native JPEG encoding failed")
	}
	defer C.CFRelease(C.CFTypeRef(data))
	out.Write(unsafe.Slice((*byte)(unsafe.Pointer(C.CFDataGetBytePtr(data))), int(C.CFDataGetLength(data))))
	return nil
}
