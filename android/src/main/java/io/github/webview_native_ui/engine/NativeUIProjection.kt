/*
 * @webview-native-ui/engine
 * Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
 * SPDX-License-Identifier: MIT
 */

package io.github.webview_native_ui.engine

import android.annotation.SuppressLint
import android.graphics.RectF
import android.net.Uri
import android.view.View
import android.view.ViewTreeObserver
import android.view.Window
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Plugin-owned registration; uses the plugin's existing events without wrapping its methods. */
class NativeUIProjection
@JvmOverloads
constructor(
    private val window: Window,
    private val webView: WebView,
    plugin: String,
    projectionSelector: String,
    private val receiveListeners: ReceiveListeners = ReceiveListeners(),
    allowedOrigins: Set<String>? = null,
    failedFallback: FailedFallback = FailedFallback.WEB,
    private val captureMode: CaptureMode = CaptureMode.COMPOSITED,
    private val canCapture: () -> Boolean = { true },
    private val beforeNativeReveal: () -> Unit = {},
    private val updatePlacement: ((JSONObject) -> Unit)? = null,
    private val runtime: Runtime = Runtime.CAPACITOR,
    captureDelayMs: Int = 50,
    values: Map<String, ValueBinding> = emptyMap(),
    private val readValues: (() -> JSONObject)? = null,
    view: () -> View?,
) : AutoCloseable {
    enum class Runtime {
        CAPACITOR,
        CORDOVA,
    }

    /** True only after an opaque VIEW handoff hid native pixels. Main-thread access only. */
    var isProjecting: Boolean = false
        private set

    private fun prepareNativeReveal() {
        isProjecting = false
        if (captureMode == CaptureMode.VIEW && !suspended && visible) beforeNativeReveal()
    }

    /** VIEW is for opaque software-renderable views; SurfaceView/video requires COMPOSITED. */
    enum class CaptureMode {
        COMPOSITED,
        VIEW,
    }

    enum class FailedFallback(val value: String) {
        WEB("web"),
        NATIVE("native"),
    }

    data class ValueBinding(val property: String? = null) {
        internal fun configuration() = JSONObject().apply { property?.let { put("property", it) } }
    }

    data class ReceiveListeners(
        val update: List<String> = emptyList(),
        val projection: Projection = Projection(),
        val match: Map<String, Any> = emptyMap(),
    ) {
        data class Projection(
            val native: List<String> = emptyList(),
            val web: List<String> = emptyList(),
            val none: List<String> = emptyList(),
        )

        internal fun configuration() =
            JSONObject()
                .put("update", JSONArray(update))
                .put(
                    "projection",
                    JSONObject()
                        .put("native", JSONArray(projection.native))
                        .put("web", JSONArray(projection.web))
                        .put("none", JSONArray(projection.none)),
                )
                .put("match", JSONObject(match))
    }

    companion object {
        private val registrations =
            java.util.WeakHashMap<
                WebView,
                MutableMap<String, java.lang.ref.WeakReference<NativeUIProjection>>,
            >()
        private val origins = java.util.WeakHashMap<WebView, Set<String>>()

        /** Call during plugin load, before navigation. Later SDK views reuse this channel. */
        @JvmStatic
        @JvmOverloads
        fun install(webView: WebView, allowedOrigins: Set<String>? = null) {
            check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
            val resolvedOrigins =
                allowedOrigins ?: origins[webView] ?: ProjectionOrigins.configured(webView.context)
            if (registrations.containsKey(webView)) {
                require(origins[webView] == resolvedOrigins) {
                    "Native UI channel origins cannot change"
                }
                return
            }
            check(webView.url == null || webView.url == "about:blank") {
                "Install NativeUIProjection during plugin load, before WebView navigation"
            }
            val owners = mutableMapOf<String, java.lang.ref.WeakReference<NativeUIProjection>>()
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(webView, "nativeUIEngine", resolvedOrigins) {
                    _,
                    message,
                    _,
                    mainFrame,
                    _ ->
                    if (mainFrame)
                        runCatching { JSONObject(message.data ?: "") }
                            .getOrNull()
                            ?.let {
                                owners[it.optString("key").substringBefore(":")]?.get()?.let { owner
                                    ->
                                    if (!owner.closed) owner.receive(it)
                                }
                            }
                }
            } else throw UnsupportedOperationException("WebView message listeners are required")
            registrations[webView] = owners
            origins[webView] = resolvedOrigins.toSet()
        }
    }

    @Volatile private var notificationDestination: String? = null

    /** Observe an existing notification; retain state without replaying or emitting events. */
    fun receive(eventName: String, data: JSONObject? = null) {
        if (
            !receiveListeners.match.all { (key, expected) ->
                val actual = data?.opt(key)
                if (actual is Number && expected is Number) actual.toDouble() == expected.toDouble()
                else actual == expected
            }
        )
            return
        val routes = receiveListeners.projection
        val matches =
            listOf("native" to routes.native, "web" to routes.web, "none" to routes.none).filter {
                eventName in it.second
            }
        if (matches.size == 1) notificationDestination = matches.single().first
        if (
            runtime == Runtime.CORDOVA &&
                (matches.isNotEmpty() || eventName in receiveListeners.update)
        ) {
            val args = JSONArray().put(id).put(eventName).put(data ?: JSONObject()).toString()
            webView.post {
                if (!closed) evaluate("globalThis.WebViewNativeUIEngineRuntime?.notify(...$args)")
            }
        }
    }

    private val resolvedOrigins =
        allowedOrigins
            ?: origins[webView]
            ?: if (runtime == Runtime.CAPACITOR) ProjectionOrigins.configured(webView.context)
            else ProjectionOrigins.defaults
    private val allowedOriginsJSON = JSONArray(resolvedOrigins).toString()

    // Check in the executing document: a native URL check can race navigation.
    private fun evaluate(source: String, complete: android.webkit.ValueCallback<String>? = null) {
        webView.evaluateJavascript(
            "if ($allowedOriginsJSON.includes(location.origin)) { $source }",
            complete,
        )
    }

    private val sourceView = view

    private fun views() = sourceView()?.let { mapOf("view" to it) } ?: emptyMap()

    private val id = "nativeUI" + UUID.randomUUID().toString().replace("-", "")
    private val snapshotDirectory = File(webView.context.cacheDir, "native-ui-engine/$id")
    private val snapshots = NativeUISnapshots(snapshotDirectory)

    /** Delegate a CordovaPluginPathHandler here; serves only this registration's PNGs. */
    fun handleResource(path: String): WebResourceResponse? {
        val prefix = "__native_ui_engine__/$id/"
        if (runtime != Runtime.CORDOVA || !path.startsWith(prefix)) return null
        val name = path.removePrefix(prefix)
        val stream =
            if (!closed && name.matches(Regex("[a-fA-F0-9-]+-[0-9]+\\.png"))) {
                try {
                    File(snapshotDirectory, name).inputStream()
                } catch (_: java.io.IOException) {
                    null
                }
            } else null
        return if (stream != null)
            WebResourceResponse(
                "image/png",
                null,
                200,
                "OK",
                mapOf("Cache-Control" to "no-store"),
                stream,
            )
        else
            WebResourceResponse(
                "text/plain",
                "UTF-8",
                404,
                "Not Found",
                emptyMap(),
                java.io.ByteArrayInputStream(byteArrayOf()),
            )
    }

    private data class Anchor(val native: RectF, val image: RectF)

    private val anchors = mutableMapOf<String, Map<String, Anchor>>()
    private val webReadyTokens = mutableSetOf<String>()
    private var latestReadyToken: String? = null
    private var unclaimedDragToken: String? = null
    private var dragScroll: JSONObject? = null
    private var dragScale = 1f

    // This path only starts from settled native ownership, never during a return.
    private fun coverBeforeScroll(drag: NativeUIWindowInteraction.Drag) {
        if (
            closed ||
                suspended ||
                !visible ||
                destination != "native" ||
                notificationDestination?.let { it != "native" } == true ||
                captureMode != CaptureMode.VIEW ||
                updatePlacement == null ||
                isProjecting
        )
            return
        val token = latestReadyToken ?: return
        if (token !in webReadyTokens || snapshots.hidesNativeViews(token)) return
        val scroll = dragScroll ?: return
        val viewport = scroll.optJSONObject("viewport") ?: return
        val origin = IntArray(2)
        webView.getLocationOnScreen(origin)
        val x = (drag.downX - origin[0]) / dragScale
        val y = (drag.downY - origin[1]) / dragScale
        fun contains(rect: JSONObject) =
            x >= rect.optDouble("x") &&
                y >= rect.optDouble("y") &&
                x < rect.optDouble("x") + rect.optDouble("width") &&
                y < rect.optDouble("y") + rect.optDouble("height")
        if (
            x < 0 ||
                y < 0 ||
                x >= webView.width / dragScale ||
                y >= webView.height / dragScale ||
                !contains(viewport)
        )
            return
        val vertical = kotlin.math.abs(drag.dy) > kotlin.math.abs(drag.dx)
        val delta = if (vertical) drag.dy else drag.dx
        val offset = scroll.optDouble(if (vertical) "offsetY" else "offsetX")
        val remaining = scroll.optDouble(if (vertical) "rangeY" else "rangeX") - offset
        if (!offset.isFinite() || !remaining.isFinite() || offset < 0 || remaining < 0) return
        if ((delta > 0 && offset <= 0) || (delta < 0 && remaining <= 0)) return
        val selected = captured[token] ?: return
        val current = views()
        if (
            selected.isEmpty() ||
                selected.any { (id, view) ->
                    current[id] !== view || !view.isShown || view.isLayoutRequested
                } ||
                !canCapture()
        )
            return
        // Screen origin + unscaled bounds only describe translation-only hierarchies.
        // Otherwise keep the existing path, including native-owned input gestures.
        fun translationOnly(view: View) =
            generateSequence(view) { it.parent as? View }
                .all {
                    it.scaleX == 1f &&
                        it.scaleY == 1f &&
                        it.rotation == 0f &&
                        it.rotationX == 0f &&
                        it.rotationY == 0f
                }
        if (!translationOnly(webView) || selected.values.any { !translationOnly(it) }) return
        // Native controls own gestures that start on them. Do not alter their input target.
        if (
            selected.any { (id, view) ->
                val anchor = anchors[token]?.get(id)?.native
                anchor == null ||
                    kotlin.math.abs(anchor.width() - view.width) >= 0.1f ||
                    kotlin.math.abs(anchor.height() - view.height) >= 0.1f
            }
        )
            return
        val location = IntArray(2)
        if (
            selected.values.any { view ->
                view.getLocationOnScreen(location)
                drag.downX >= location[0] &&
                    drag.downX < location[0] + view.width &&
                    drag.downY >= location[1] &&
                    drag.downY < location[1] + view.height
            }
        )
            return
        if (!snapshots.coverView(token, window, webView, selected.values.distinct())) return
        isProjecting = true
        unclaimedDragToken = token
        reply(null, JSONObject().put("active", true).put("precovered", token))
    }

    private val captured = mutableMapOf<String, Map<String, View>>()
    private var destination = "native"
    private var connected = false
    private var restoreAccepted = true
    private val hiddenByProjection = mutableSetOf<View>()
    private var coverGeneration = 0L
    internal var awaitWebDraw: (WebView, () -> Boolean, (Boolean) -> Unit) -> Unit =
        NativeUIWebReadiness::draw
    private var suspended = false
    private var visible = true
    @Volatile private var closed = false
    private var documentID: String? = null
    private val script: ScriptHandler
    private val stopInteraction: () -> Unit
    private var windowInteracting = false

    private fun resetSnapshots() {
        latestReadyToken = null
        unclaimedDragToken = null
        snapshots.reset()
        snapshots.interaction(windowInteracting)
    }

    init {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        require(updatePlacement == null || captureMode == CaptureMode.VIEW) {
            "Placement handoff requires VIEW capture mode"
        }
        require(projectionSelector.isNotBlank())
        require(captureDelayMs >= 0) { "captureDelayMs must be nonnegative" }
        val config =
            JSONObject()
                .put("runtime", if (runtime == Runtime.CORDOVA) "cordova" else "capacitor")
                .put("id", id)
                .put("plugin", plugin)
                .put("projectionSelector", projectionSelector)
                .put("captureDelayMs", captureDelayMs)
                .put("receiveListeners", receiveListeners.configuration())
                .put("failedFallback", failedFallback.value)
                .put("captureMode", if (captureMode == CaptureMode.VIEW) "view" else "composited")
        if (readValues != null)
            config.put("values", JSONObject(values.mapValues { it.value.configuration() }))
        if (updatePlacement != null)
            config.put("placementHandoff", true).put("nativeDragHandoff", true)
        val runtime =
            webView.context.assets.open("native-ui-engine.js").bufferedReader().use {
                it.readText()
            }
        val source =
            "if (!globalThis.WebViewNativeUIEngineRuntime) { $runtime } WebViewNativeUIEngineRuntime.start($config).catch(console.error);"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            install(webView, resolvedOrigins)
            registrations.getValue(webView)[id] = java.lang.ref.WeakReference(this)
            var installedScript: ScriptHandler? = null
            try {
                val created =
                    WebViewCompat.addDocumentStartJavaScript(webView, source, resolvedOrigins)
                installedScript = created
                // Also support initialization after the current page has loaded.
                evaluate(source)
                script = created
            } catch (error: Exception) {
                installedScript?.remove()
                registrations[webView]?.remove(id)
                snapshots.close()
                throw error
            }
        } else throw UnsupportedOperationException("WebView document-start scripts are required")
        stopInteraction =
            NativeUIWindowInteraction.observe(window, drag = ::coverBeforeScroll) { active ->
                windowInteracting = active
                snapshots.interaction(active)
                reply(null, JSONObject().put("active", active))
            }
    }

    private fun frame(view: View): RectF {
        val a = IntArray(2)
        val b = IntArray(2)
        view.getLocationInWindow(a)
        webView.getLocationInWindow(b)
        return RectF(
            (a[0] - b[0]).toFloat(),
            (a[1] - b[1]).toFloat(),
            (a[0] - b[0] + view.width).toFloat(),
            (a[1] - b[1] + view.height).toFloat(),
        )
    }

    private fun receive(message: JSONObject) {
        if (closed) return
        val key = message.optString("key")
        if (!key.startsWith("$id:")) return
        val page = key.split(":").getOrNull(1)
        if (documentID != page) {
            coverGeneration++
            prepareNativeReveal()
            resetSnapshots()
            webReadyTokens.clear()
            captured.clear()
            anchors.clear()
            documentID = page
        }
        val request = message.optJSONObject("request") ?: return
        val token = request.optString("token")
        val complete: (JSONObject) -> Unit = { value ->
            if (!closed && documentID == page) reply(key, value)
        }
        fun applyPlacement(): Boolean {
            if (closed || suspended || !visible) return false
            val placement = request.optJSONObject("placement") ?: return true
            val selected = captured[token]
            val current = views()
            if (
                !snapshots.hidesNativeViews(token) ||
                    selected.isNullOrEmpty() ||
                    selected.any { (id, view) -> current[id] !== view }
            ) {
                reply(key, JSONObject(), "Native placement token is no longer active")
                return false
            }
            return try {
                updatePlacement?.invoke(placement)
                !closed && !suspended && visible
            } catch (error: Exception) {
                reply(key, JSONObject(), error.message ?: "Native placement update failed")
                false
            }
        }
        fun ownsHiddenToken(): Boolean {
            val selected = captured[token] ?: return false
            val current = views()
            return snapshots.hidesNativeViews(token) &&
                selected.isNotEmpty() &&
                selected.all { (id, view) -> current[id] === view }
        }
        when (request.optString("action")) {
            "values" -> {
                try {
                    complete(JSONObject().put("values", readValues?.invoke() ?: JSONObject()))
                } catch (error: Exception) {
                    reply(key, JSONObject(), error.message ?: "Cannot read native values")
                }
            }
            "connect" -> {
                if (!connected) {
                    destination =
                        (if (views().values.any { it.visibility == View.VISIBLE }) "native"
                        else "none")
                    connected = true
                }
                complete(JSONObject().put("destination", notificationDestination ?: destination))
            }
            "destination" -> {
                request
                    .optString("destination")
                    .takeIf { it in listOf("native", "web", "none") }
                    ?.let {
                        destination = it
                        connected = true
                    }
                complete(JSONObject())
            }
            "track" -> {
                val width = request.optDouble("viewportWidth")
                dragScroll =
                    if (width.isFinite() && width > 0) request.optJSONObject("gesture") else null
                if (dragScroll != null) dragScale = (webView.width / width).toFloat()
                complete(JSONObject().put("tracked", false))
            }
            "prepare" -> {
                val ids =
                    request.optJSONArray("ids")?.let { array ->
                        (0 until array.length()).map { array.optString(it) }
                    } ?: emptyList()
                val selected = views().filterKeys { it in ids }
                if (!visible || !canCapture() || ids.isEmpty() || selected.size != ids.size) {
                    complete(JSONObject())
                    return
                }
                snapshots.prepare(
                    window,
                    webView,
                    request.optDouble("viewportWidth"),
                    {
                        val current = views()
                        if (
                            !visible ||
                                !canCapture() ||
                                selected.any { (id, view) ->
                                    current[id] !== view || !view.isShown || view.isLayoutRequested
                                }
                        )
                            emptyMap()
                        else selected.mapValues { frame(it.value) }
                    },
                    sourceViews = if (captureMode == CaptureMode.VIEW) ({ selected }) else null,
                    contentRevision = request.optLong("revision"),
                ) { result ->
                    result
                        .optString("token")
                        .takeIf { it.isNotEmpty() }
                        ?.let { token ->
                            captured[token] = selected
                            val scale =
                                (webView.width / request.optDouble("viewportWidth")).toFloat()
                            val parts = result.optJSONArray("parts") ?: JSONArray()
                            val entries = mutableMapOf<String, Anchor>()
                            for (index in 0 until parts.length()) {
                                val part = parts.getJSONObject(index)
                                val x = part.getDouble("x").toFloat() * scale
                                val y = part.getDouble("y").toFloat() * scale
                                val image =
                                    RectF(
                                        x,
                                        y,
                                        x + part.getDouble("width").toFloat() * scale,
                                        y + part.getDouble("height").toFloat() * scale,
                                    )
                                val ids = part.getJSONArray("ids")
                                for (i in 0 until ids.length()) {
                                    val id = ids.getString(i)
                                    selected[id]?.let { entries[id] = Anchor(frame(it), image) }
                                }
                            }
                            anchors[token] = entries
                            if (captureMode == CaptureMode.VIEW) snapshots.discardViewBitmaps(token)
                        }
                    complete(result)
                }
            }
            "prepared" -> {
                awaitWebDraw(
                    webView,
                    { !closed && !suspended && visible && captured.containsKey(token) },
                ) { ready ->
                    if (ready) {
                        webReadyTokens.add(token)
                        latestReadyToken = token
                    }
                    complete(JSONObject())
                }
            }
            "cover" -> {
                val generation = ++coverGeneration
                val selected = captured[token] ?: emptyMap()
                val current = views()
                val valid =
                    visible &&
                        canCapture() &&
                        selected.isNotEmpty() &&
                        selected.all { (id, view) -> current[id] === view }
                val frames =
                    if (request.has("parts")) snapshots.projectionFrames(request, webView) else null
                if (request.has("parts") && frames == null) {
                    complete(JSONObject().put("shown", false))
                    return
                }
                restoreAccepted = true
                if (captureMode == CaptureMode.VIEW && valid) {
                    fun coverView() =
                        snapshots
                            .coverView(token, window, webView, selected.values.distinct())
                            .also {
                                if (it) {
                                    isProjecting = true
                                    unclaimedDragToken = null
                                }
                            }
                    if (token in webReadyTokens) complete(JSONObject().put("shown", coverView()))
                    else {
                        val current = {
                            !closed &&
                                generation == coverGeneration &&
                                !suspended &&
                                visible &&
                                captured[token] == selected &&
                                selected.all { (id, view) -> views()[id] === view } &&
                                canCapture()
                        }
                        awaitWebDraw(webView, current) { ready ->
                            val accepted = ready && current()
                            if (accepted) webReadyTokens.add(token)
                            complete(JSONObject().put("shown", accepted && coverView()))
                        }
                    }
                } else
                    complete(
                        JSONObject()
                            .put(
                                "shown",
                                valid &&
                                    snapshots.cover(
                                        token,
                                        window,
                                        webView,
                                        selected.values.distinct(),
                                        true,
                                        frames = frames,
                                    ),
                            )
                    )
            }
            "restore" -> {
                coverGeneration++
                restoreAccepted = false
                if (suspended || !visible) {
                    complete(JSONObject().put("shown", false))
                    return
                }
                val frames =
                    snapshots.projectionFrames(request, webView)
                        ?: run {
                            complete(JSONObject().put("shown", false))
                            return
                        }
                if (!applyPlacement()) return
                prepareNativeReveal()
                val current = views()
                for ((id, target) in frames) {
                    val view = current[id]
                    val anchor = anchors[token]?.get(id)
                    if (view == null || captured[token]?.get(id) !== view || anchor == null) {
                        complete(JSONObject().put("shown", false))
                        return
                    }
                    val old = frame(view)
                    if (
                        kotlin.math.abs(old.width() - anchor.native.width()) >= 0.1f ||
                            kotlin.math.abs(old.height() - anchor.native.height()) >= 0.1f ||
                            kotlin.math.abs(target.width() - anchor.image.width()) >= 0.1f ||
                            kotlin.math.abs(target.height() - anchor.image.height()) >= 0.1f
                    ) {
                        complete(JSONObject().put("shown", false))
                        return
                    }
                }
                // A successful plugin placement is newer than the image's return frame.
                // Only legacy consumers need the captured anchor to position native views.
                if (updatePlacement == null || request.optJSONObject("placement") == null) {
                    for ((id, target) in frames) {
                        val view = current.getValue(id)
                        val old = frame(view)
                        val anchor = anchors.getValue(token).getValue(id)
                        view.translationX +=
                            anchor.native.left + target.left - anchor.image.left - old.left
                        view.translationY +=
                            anchor.native.top + target.top - anchor.image.top - old.top
                    }
                }
                restoreAccepted =
                    captureMode == CaptureMode.VIEW ||
                        snapshots.restore(token, window, webView, frames)
                complete(JSONObject().put("shown", restoreAccepted))
            }
            "resume" -> {
                coverGeneration++
                if (!restoreAccepted || suspended) {
                    reply(key, JSONObject(), "Native UI geometry changed or hidden")
                    return
                }
                prepareNativeReveal()
                snapshots.restoreViews()
                snapshots.finishCovering()
                afterNativeDraw(
                    { complete(JSONObject()) },
                    { reply(key, JSONObject(), "Native UI did not draw") },
                )
            }

            "visibility" -> {
                coverGeneration++
                visible = request.optBoolean("visible") && !suspended
                if (visible) {
                    if (!applyPlacement()) return
                    prepareNativeReveal()
                    snapshots.restoreViews()
                } else {
                    isProjecting = false
                    snapshots.dismiss()
                }
                if (visible) {
                    hiddenByProjection.forEach {
                        if (it.visibility == View.INVISIBLE) it.visibility = View.VISIBLE
                    }
                    hiddenByProjection.clear()
                } else {
                    views()
                        .values
                        .filter { it.visibility == View.VISIBLE }
                        .forEach {
                            hiddenByProjection.add(it)
                            it.visibility = View.INVISIBLE
                        }
                }
                complete(JSONObject())
            }
            "painted" ->
                if (captureMode == CaptureMode.VIEW) complete(JSONObject())
                else
                    snapshots.retireCopyAfterWebDraw(token, webView) { ready ->
                        if (ready) complete(JSONObject())
                        else reply(key, JSONObject(), "Web image did not draw")
                    }
            "restored" -> {
                snapshots.retireCopy(token, false)
                complete(JSONObject())
            }
            "release" -> {
                val revealing = ownsHiddenToken()
                if (revealing) {
                    if (unclaimedDragToken == token && request.optJSONObject("placement") == null) {
                        complete(JSONObject().put("requiresPlacement", true))
                        return
                    }
                    if (!applyPlacement()) return
                    prepareNativeReveal()
                }
                if (unclaimedDragToken == token) unclaimedDragToken = null
                snapshots.release(token)
                webReadyTokens.remove(token)
                if (latestReadyToken == token) latestReadyToken = null
                captured.remove(token)
                anchors.remove(token)
                if (revealing)
                    afterNativeDraw(
                        { complete(JSONObject()) },
                        { reply(key, JSONObject(), "Native UI did not draw") },
                    )
                else complete(JSONObject())
            }
            "reset" -> {
                coverGeneration++
                if (!suspended && visible && !applyPlacement()) return
                prepareNativeReveal()
                resetSnapshots()
                webReadyTokens.clear()
                captured.clear()
                anchors.clear()
                complete(JSONObject())
            }
            else -> complete(JSONObject())
        }
    }

    private fun afterNativeDraw(complete: () -> Unit, failed: () -> Unit) {
        val root = window.decorView
        val observer = root.viewTreeObserver
        lateinit var listener: android.view.ViewTreeObserver.OnDrawListener
        var done = false
        val finish = Runnable {
            if (!done) {
                done = true
                if (observer.isAlive) observer.removeOnDrawListener(listener)
                complete()
            }
        }
        listener =
            android.view.ViewTreeObserver.OnDrawListener {
                root.postOnAnimation { root.post(finish) }
            }
        observer.addOnDrawListener(listener)
        root.invalidate()
        root.postDelayed(
            {
                if (!done) {
                    done = true
                    if (observer.isAlive) observer.removeOnDrawListener(listener)
                    failed()
                }
            },
            250,
        )
    }

    private fun reply(key: String?, value: JSONObject, error: String? = null) {
        if (closed) return
        if (runtime == Runtime.CORDOVA)
            value.optJSONArray("parts")?.let { parts ->
                for (index in 0 until parts.length()) {
                    val part = parts.getJSONObject(index)
                    val uri = Uri.parse(part.optString("url"))
                    if (uri.scheme == "file")
                        part.put("url", "/__native_ui_engine__/$id/${uri.lastPathSegment}")
                }
            }
        val args =
            JSONArray().put(id).put(key ?: JSONObject.NULL).put(value).put(error ?: JSONObject.NULL)
        evaluate("globalThis.WebViewNativeUIEngineRuntime?.receive(...$args)")
    }

    /** Hide pixels immediately; completion confirms the Web proxy has also been retired. */
    fun hide(complete: (Boolean) -> Unit = {}) {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        coverGeneration++
        isProjecting = false
        suspended = true
        visible = false
        destination = "none"
        notificationDestination = "none"
        connected = true
        snapshots.dismiss()
        webReadyTokens.clear()
        views()
            .values
            .filter { it.visibility == View.VISIBLE }
            .forEach {
                hiddenByProjection.add(it)
                it.visibility = View.INVISIBLE
            }
        var done = false
        val timeout = Runnable {
            if (!done) {
                done = true
                complete(false)
            }
        }
        webView.postDelayed(timeout, 5000)
        evaluate("globalThis.WebViewNativeUIEngineRuntime?.hide('$id') === true") { result ->
            if (!done) {
                done = true
                webView.removeCallbacks(timeout)
                complete(result == "true")
            }
        }
    }

    /** Permit subsequent native presentation after a completed hide. */
    fun show() {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        suspended = false
        destination = "native"
        notificationDestination = "native"
        connected = true
        evaluate("globalThis.WebViewNativeUIEngineRuntime?.show('$id')")
    }

    // A ScriptHandler exists only after constructor validation of DOCUMENT_START_SCRIPT.
    @SuppressLint("RequiresFeature")
    override fun close() {
        if (closed) return
        closed = true
        isProjecting = false
        coverGeneration++
        stopInteraction()
        evaluate("globalThis.WebViewNativeUIEngineRuntime?.stop('$id')")
        script.remove()
        registrations[webView]?.remove(id)
        // A successful hide notification may precede its asynchronous Web acknowledgement.
        val remainHidden = (notificationDestination ?: destination) == "none"
        val visibility =
            if (remainHidden)
                (views().values + hiddenByProjection + captured.values.flatMap { it.values })
                    .associateWith { it.visibility }
            else emptyMap()
        snapshots.close()
        webReadyTokens.clear()
        captured.clear()
        anchors.clear()
        if (remainHidden) visibility.forEach { (view, previous) -> view.visibility = previous }
        else
            hiddenByProjection.forEach {
                if (it.visibility == View.INVISIBLE) it.visibility = View.VISIBLE
            }
        hiddenByProjection.clear()
    }
}
