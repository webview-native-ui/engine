package io.github.webview_native_ui.engine

import android.graphics.Bitmap
import android.os.Build
import java.io.OutputStream
import java.nio.ByteBuffer

/** PNG encoding only. PixelCopy, renderer captures and Web handoff remain platform-owned. */
internal object NativeUIPng {
    internal val available =
        try {
            System.loadLibrary("native_ui_png")
            true
        } catch (_: LinkageError) {
            false
        }

    external fun encode(buffer: ByteBuffer, width: Int, height: Int, stride: Int): ByteArray?

    fun write(bitmap: Bitmap, output: OutputStream): Boolean {
        val supported =
            available &&
                Build.VERSION.SDK_INT >= 26 &&
                bitmap.config == Bitmap.Config.ARGB_8888 &&
                bitmap.colorSpace?.isSrgb == true &&
                bitmap.width.toLong() * bitmap.height <= 8_000_000
        if (supported) {
            val pixels = ByteBuffer.allocateDirect(bitmap.byteCount)
            bitmap.copyPixelsToBuffer(pixels)
            pixels.rewind()
            // Rust verifies opacity before removing alpha. Nonopaque input falls back,
            // preserving Android's premultiplication and color-management behavior.
            val png = encode(pixels, bitmap.width, bitmap.height, bitmap.rowBytes)
            if (png != null) {
                output.write(png)
                return true
            }
        }
        return bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
    }
}
