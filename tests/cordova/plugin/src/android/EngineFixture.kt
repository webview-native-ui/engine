/*
 * @webview-native-ui/engine
 * Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
 * SPDX-License-Identifier: MIT
 */

package dev.rdlabo.engine.fixture

import android.graphics.Color
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import io.github.webview_native_ui.engine.NativeUIProjection
import java.io.File
import org.apache.cordova.*
import org.json.JSONArray
import org.json.JSONObject

class EngineFixture : CordovaPlugin() {
    private var projection: NativeUIProjection? = null
    private lateinit var native: TextView
    private lateinit var web: WebView

    override fun pluginInitialize() {
        web = webView.view as WebView
        NativeUIProjection.install(web)
        native =
            TextView(cordova.activity).apply {
                text = "Native Engine"
                setBackgroundColor(Color.rgb(20, 120, 220))
                setTextColor(Color.WHITE)
            }
        (cordova.activity.window.decorView as android.view.ViewGroup).addView(
            native,
            FrameLayout.LayoutParams(1, 1),
        )
        projection =
            NativeUIProjection(
                cordova.activity.window,
                web,
                serviceName,
                "#slot",
                receiveListeners =
                    NativeUIProjection.ReceiveListeners(
                        update = listOf("updated"),
                        projection =
                            NativeUIProjection.ReceiveListeners.Projection(
                                native = listOf("native"),
                                web = listOf("web"),
                                none = listOf("none"),
                            ),
                    ),
                runtime = NativeUIProjection.Runtime.CORDOVA,
                view = { native },
            )
    }

    override fun getPathHandler() = CordovaPluginPathHandler { path ->
        projection?.handleResource(path)
    }

    override fun execute(action: String, args: JSONArray, callback: CallbackContext): Boolean {
        cordova.activity.runOnUiThread {
            when (action) {
                "place" -> {
                    val rect = args.getJSONObject(0)
                    val scale = web.width / rect.getDouble("viewport")
                    val origin = IntArray(2)
                    web.getLocationInWindow(origin)
                    native.layoutParams =
                        FrameLayout.LayoutParams(
                            (rect.getDouble("width") * scale).toInt(),
                            (rect.getDouble("height") * scale).toInt(),
                        )
                    native.x = origin[0] + (rect.getDouble("x") * scale).toFloat()
                    native.y = origin[1] + (rect.getDouble("y") * scale).toFloat()
                    projection?.receive("updated")
                    callback.success()
                }
                "native",
                "web",
                "none" -> {
                    projection?.receive(action)
                    callback.success()
                }
                "status" ->
                    callback.success(JSONObject().put("visible", native.visibility == View.VISIBLE))
                "report" -> {
                    File(cordova.activity.filesDir, "engine-result.json")
                        .writeText(args.getJSONObject(0).toString())
                    callback.success()
                }
                else -> callback.error("Unknown action")
            }
        }
        return true
    }

    override fun onDestroy() {
        projection?.close()
        projection = null
        (native.parent as? android.view.ViewGroup)?.removeView(native)
    }
}
