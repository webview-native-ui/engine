#include <jni.h>
#include <limits.h>
#include "NativeUIPng.h"
JNIEXPORT jbyteArray JNICALL
Java_io_github_webview_1native_1ui_engine_NativeUIPng_encode(JNIEnv *env, jobject owner,
    jobject buffer, jint width, jint height, jint stride) {
    (void)owner;
    if (!buffer || width <= 0 || height <= 0 || stride <= 0) return NULL;
    jlong capacity = (*env)->GetDirectBufferCapacity(env, buffer);
    const uint8_t *pixels = (*env)->GetDirectBufferAddress(env, buffer);
    if (!pixels || capacity <= 0) return NULL;
    NativeUIPngBuffer output = {0};
    if (native_ui_png_encode(pixels, (size_t)capacity, (uint32_t)width, (uint32_t)height,
                            (size_t)stride, 8, 2, NULL, 0, &output) != 0) return NULL;
    jbyteArray result = output.len <= INT_MAX ? (*env)->NewByteArray(env, (jsize)output.len) : NULL;
    if (result) (*env)->SetByteArrayRegion(env, result, 0, (jsize)output.len, (const jbyte *)output.data);
    native_ui_png_free(output);
    return result;
}
