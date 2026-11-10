package io.github.webview_native_ui.engine

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ColorSpace
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 26)
class NativeUIPngTest {
    @Test
    fun opaquePixelsUseRustRgbAndRoundTripExactly() {
        assertTrue("Packaged Rust JNI library must load", NativeUIPng.available)
        val source = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val colors = intArrayOf(Color.RED, Color.GREEN, Color.BLUE, Color.WHITE)
        source.setPixels(colors, 0, 2, 0, 0, 2, 2)
        val output = ByteArrayOutputStream()
        assertTrue(NativeUIPng.write(source, output))
        val png = output.toByteArray()
        assertEquals("Opaque PNG uses RGB", 2, png[25].toInt())
        val decoded = BitmapFactory.decodeByteArray(png, 0, png.size)
        val actual = IntArray(4)
        decoded.getPixels(actual, 0, 2, 0, 0, 2, 2)
        assertArrayEquals(colors, actual)
        decoded.recycle()
        source.recycle()
    }

    @Test
    fun transparentPixelsRequestFallbackAndKeepAlpha() {
        val source = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.argb(128, 200, 50, 100))
        val raw = ByteBuffer.allocateDirect(source.byteCount)
        source.copyPixelsToBuffer(raw)
        raw.rewind()
        assertNull(NativeUIPng.encode(raw, 1, 1, source.rowBytes))
        val output = ByteArrayOutputStream()
        assertTrue(NativeUIPng.write(source, output))
        val bytes = output.toByteArray()
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(source.getPixel(0, 0), decoded.getPixel(0, 0))
        decoded.recycle()
        source.recycle()
    }

    @Test
    fun concurrentEncodingMatchesSerialOpaqueAndAlphaBytes() {
        val sources =
            (0 until 12).map { index ->
                Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).apply {
                    eraseColor(Color.argb(if (index % 2 == 0) 255 else 128, index * 20, 50, 180))
                }
            }
        fun encode(bitmap: Bitmap): ByteArray {
            val output = ByteArrayOutputStream()
            assertTrue(NativeUIPng.write(bitmap, output))
            return output.toByteArray()
        }
        val workers = Executors.newFixedThreadPool(2)
        try {
            val expected = sources.map(::encode)
            val actual = workers.invokeAll(sources.map { bitmap -> Callable { encode(bitmap) } })
            actual.forEachIndexed { index, future ->
                assertArrayEquals(expected[index], future.get())
            }
        } finally {
            workers.shutdown()
            sources.forEach { it.recycle() }
        }
    }

    @Test
    fun wideGamutFallbackPreservesProfile() {
        val source =
            Bitmap.createBitmap(
                2,
                2,
                Bitmap.Config.RGBA_F16,
                true,
                ColorSpace.get(ColorSpace.Named.DISPLAY_P3),
            )
        source.eraseColor(Color.GREEN)
        val output = ByteArrayOutputStream()
        assertTrue(NativeUIPng.write(source, output))
        val bytes = output.toByteArray()
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(source.colorSpace, decoded.colorSpace)
        decoded.recycle()
        source.recycle()
    }
}
