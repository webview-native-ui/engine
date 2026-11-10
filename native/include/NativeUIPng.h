#ifndef NATIVE_UI_PNG_H
#define NATIVE_UI_PNG_H
#include <stdint.h>
#include <stddef.h>
typedef struct { uint8_t *data; size_t len; } NativeUIPngBuffer;
// Input is straight RGBA8/RGBA16 native-endian. Preset 1: iOS Up/level1.
// Preset 2: Android opaque RGBA8 -> RGB None/level6, rejects nonopaque input.
// Returns 0 on success. The successful owned output must be freed exactly once.
int32_t native_ui_png_encode(const uint8_t *, size_t, uint32_t, uint32_t, size_t,
                            uint32_t, uint32_t, const uint8_t *, size_t, NativeUIPngBuffer *);
void native_ui_png_free(NativeUIPngBuffer);
#endif
