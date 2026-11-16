package io.github.webview_native_ui.engine

import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.webkit.WebView
import android.widget.ImageView
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.floor
import org.json.JSONArray
import org.json.JSONObject

/**
 * Prepared composited pixels. No capture or encoding is performed by cover/restore. Main-thread
 * API.
 */
class NativeUISnapshots(private val directory: File) : AutoCloseable {
    private data class Part(val id: String, val frame: RectF, val bitmap: Bitmap, val file: File)

    private data class Capture(
        val width: Int,
        val height: Int,
        val origin: List<Int>,
        val referenceWidth: Int,
        val referenceHeight: Int,
        val parts: List<Part>,
    )

    private data class Copy(
        val token: String,
        val entry: Boolean,
        val root: ViewGroup,
        val views: List<ImageView>,
    )

    private companion object {
        // Shared across captures/instances; large crops retain the serial path.
        val pngWorkers = Executors.newFixedThreadPool(2)
    }

    private val main = Handler(Looper.getMainLooper())
    private val encoder = Executors.newSingleThreadExecutor()
    private val captures = mutableMapOf<String, Capture>()

    private data class ViewState(
        val width: Int,
        val height: Int,
        val direction: Int,
        val alpha: Float,
        val configuration: Configuration,
    )

    private fun viewState(view: View) =
        ViewState(
            view.width,
            view.height,
            view.layoutDirection,
            view.alpha,
            Configuration(view.resources.configuration),
        )

    private data class ViewCache(
        val revision: Long,
        val views: Map<String, View>,
        val regions: Map<String, Rect>,
        val window: WeakReference<Window>,
        val states: Map<String, ViewState>,
        val parts: List<Part>,
    )

    private var viewCache: ViewCache? = null
    private val expiredEntries = mutableSetOf<String>()
    private var copy: Copy? = null
    private var hidden: Pair<String, List<Pair<View, Int>>>? = null
    private var generation = 0L
    private var touching = false
    private var pending = false
    private var closed = false

    private class Acquisition(val id: String, val owner: String, val epoch: Long) {
        var run: (() -> Unit)? = null
        var cancel: (() -> Unit)? = null
        var hit: ((MotionEvent) -> Boolean)? = null
        var stop: ((MotionEvent) -> Unit)? = null
        var contact: (() -> Unit)? = null
        var contactTimeout: Runnable? = null
        var pixels = false
        var token: String? = null
        var pinned = false
        var changedAt = SystemClock.uptimeMillis()
    }

    private var epoch = 0L
    private val acquisitions = linkedMapOf<String, Acquisition>()
    private var observedWindow: Window? = null
    private var interactionListener: ((JSONObject) -> Unit)? = null
    private var stopObserver: (() -> Unit)? = null

    /** Acquire immutable pixels before native input; encoding continues after input is replayed. */
    fun observeInteractions(window: Window, changed: (JSONObject) -> Unit): () -> Unit {
        onMain()
        stopObserver?.invoke()
        if (!supported || closed) return {}
        observedWindow = window
        interactionListener = changed
        val remove =
            NativeUIWindowInteraction.observe(
                window,
                contact = { event, complete ->
                    val selected =
                        acquisitions.values.toList().filter {
                            it.pixels || it.hit?.invoke(event) == true
                        }
                    if (selected.isEmpty()) false
                    else {
                        var remaining = selected.size
                        selected.forEach { job ->
                            job.pinned = true
                            job.contact = {
                                if (job.pixels)
                                    changed(
                                        JSONObject()
                                            .put("active", true)
                                            .put("captureID", job.id)
                                            .put("captureOwner", job.owner)
                                            .put("captureState", "processing")
                                    )
                                if (--remaining == 0) complete(true)
                            }
                            if (job.hit?.invoke(event) == true) job.stop?.invoke(event)
                            if (job.pixels) finishContact(job)
                            else {
                                // Optional acquisition must release SDK input before the window's
                                // mandatory-return timeout can cancel the original gesture.
                                val expired = Runnable {
                                    job.cancel?.invoke() ?: finishContact(job)
                                }
                                job.contactTimeout = expired
                                main.postDelayed(expired, 750)
                                job.run?.invoke() ?: finishContact(job)
                            }
                        }
                        true
                    }
                },
            ) { active ->
                interaction(active)
                changed(JSONObject().put("active", active))
            }
        var listening = true
        val stop = {
            if (listening) {
                listening = false
                remove()
                observedWindow = null
                interactionListener = null
                epoch++
                acquisitions.values.toList().forEach { it.cancel?.invoke() }
                acquisitions.clear()
            }
        }
        stopObserver = stop
        return stop
    }

    private fun finishContact(job: Acquisition) {
        job.contactTimeout?.let { main.removeCallbacks(it) }
        job.contactTimeout = null
        val complete = job.contact
        job.contact = null
        complete?.invoke()
    }

    internal fun invalidateAcquisitions(owner: String? = null, retainPending: Boolean = false) {
        val selected =
            owner?.let { listOfNotNull(acquisitions[it]) } ?: acquisitions.values.toList()
        selected.forEach { job ->
            if (retainPending && !job.pixels) job.changedAt = SystemClock.uptimeMillis()
            else {
                acquisitions.remove(job.owner)
                if (!job.pinned) job.cancel?.invoke()
            }
        }
    }

    var coveringToken: String? = null
        private set

    val hidesNativeViews
        get() = hidden != null

    internal fun hidesNativeViews(token: String): Boolean {
        onMain()
        return hidden?.first == token
    }

    @get:androidx.annotation.ChecksSdkIntAtLeast(api = 26)
    val supported
        get() = Build.VERSION.SDK_INT >= 26

    private fun onMain() = check(Looper.myLooper() == Looper.getMainLooper())

    private fun origin(view: View): List<Int> =
        IntArray(2).also { view.getLocationInWindow(it) }.toList()

    /**
     * Dispatch an ordered image-handoff request. The renderer owns eligibility and native layout.
     */
    fun handle(
        request: JSONObject,
        window: Window,
        webView: WebView,
        frames: (Set<String>, Long) -> Map<String, RectF>,
        views: (Set<String>) -> List<View>?,
        complete: (Result<JSONObject>) -> Unit,
    ) {
        onMain()
        val respond: (JSONObject) -> Unit = { complete(Result.success(it)) }
        val token = request.optString("token")
        when (request.optString("action")) {
            "prepare" -> {
                val raw = request.optJSONArray("ids")
                val ids =
                    raw?.let { array ->
                        (0 until array.length()).map { array.opt(it) as? String ?: "" }
                    } ?: emptyList()
                val revision = request.optDouble("revision")
                val width = request.optDouble("viewportWidth")
                if (
                    ids.isEmpty() ||
                        ids.any { it.isEmpty() } ||
                        ids.toSet().size != ids.size ||
                        !revision.isFinite() ||
                        revision != request.optLong("revision").toDouble() ||
                        !width.isFinite() ||
                        width <= 0
                ) {
                    respond(JSONObject())
                    return
                }
                val expected = ids.toSet()
                if (frames(expected, request.getLong("revision")).keys != expected) {
                    respond(JSONObject())
                    return
                }
                prepareContact(
                    request,
                    window,
                    webView,
                    {
                        frames(expected, request.getLong("revision")).takeIf { it.keys == expected }
                            ?: emptyMap()
                    },
                    { views(expected).orEmpty() },
                    complete = respond,
                )
            }
            "change" -> {
                invalidateAcquisitions(
                    request.optString("captureOwner").takeIf { request.has("captureOwner") },
                    request.optBoolean("retainPending"),
                )
                respond(JSONObject())
            }
            "cover" -> {
                val ids = identifiers(token)
                val selected = if (ids.isEmpty()) null else views(ids)
                val destination =
                    if (request.has("parts")) projectionFrames(request, webView) else null
                val shown =
                    selected != null &&
                        (!request.has("parts") || destination != null) &&
                        cover(
                            token,
                            window,
                            webView,
                            selected.distinct(),
                            request.optBoolean("transient"),
                            frames = destination,
                        )
                respond(JSONObject().put("shown", shown))
            }
            "restore" -> {
                val destination = projectionFrames(request, webView)
                respond(
                    JSONObject()
                        .put(
                            "shown",
                            destination != null && restore(token, window, webView, destination),
                        )
                )
            }
            "painted",
            "restored" -> {
                retireCopyAfterWebDraw(
                    token,
                    webView,
                    entry = request.optString("action") == "painted",
                ) { ready ->
                    if (ready) respond(JSONObject())
                    else complete(Result.failure(IllegalStateException("Web image did not draw")))
                }
            }
            "release" -> {
                release(token)
                respond(JSONObject())
            }
            "reset" -> {
                reset()
                respond(JSONObject())
            }
            else -> respond(JSONObject())
        }
    }

    /** CSS viewport coordinates to physical pixels; every captured ID must occur exactly once. */
    internal fun projectionFrames(request: JSONObject, reference: View): Map<String, RectF>? {
        val parts = request.optJSONArray("parts") ?: return null
        val width = request.optDouble("viewportWidth")
        if (!width.isFinite() || width <= 0 || reference.width <= 0 || parts.length() == 0)
            return null
        val scale = reference.width / width
        val result = linkedMapOf<String, RectF>()
        for (index in 0 until parts.length()) {
            val part = parts.optJSONObject(index) ?: return null
            val x = part.optDouble("x")
            val y = part.optDouble("y")
            val w = part.optDouble("width")
            val h = part.optDouble("height")
            if (!listOf(x, y, w, h).all { it.isFinite() } || w <= 0 || h <= 0) return null
            val frame =
                RectF(
                    (x * scale).toFloat(),
                    (y * scale).toFloat(),
                    ((x + w) * scale).toFloat(),
                    ((y + h) * scale).toFloat(),
                )
            if (!frame.valid()) return null
            val ids = part.optJSONArray("ids") ?: return null
            if (ids.length() == 0) return null
            for (i in 0 until ids.length()) {
                val id = ids.opt(i) as? String ?: return null
                if (id.isEmpty() || result.containsKey(id)) return null
                result[id] = frame
            }
        }
        return result.takeIf {
            it.isNotEmpty() && it.keys == identifiers(request.optString("token"))
        }
    }

    fun changed() {
        onMain()
        generation++
        invalidateAcquisitions()
    }

    fun interaction(active: Boolean) {
        onMain()
        touching = active
        generation++
    }

    /** frames() returns current native bounds in reference-view physical pixels. */
    fun prepare(
        window: Window,
        reference: View,
        viewportWidth: Double,
        frames: () -> Map<String, RectF>,
        sourceViews: (() -> Map<String, View>)? = null,
        contentRevision: Long = 0,
        complete: (JSONObject) -> Unit,
    ) =
        prepareCapture(
            window,
            reference,
            viewportWidth,
            frames,
            sourceViews,
            contentRevision,
            complete = complete,
        )

    internal fun prepareContact(
        request: JSONObject,
        window: Window,
        reference: WebView,
        frames: () -> Map<String, RectF>,
        views: () -> List<View>,
        sourceViews: (() -> Map<String, View>)? = null,
        complete: (JSONObject) -> Unit,
    ) {
        val job =
            request
                .optString("captureID")
                .takeIf { it.isNotEmpty() && observedWindow === window }
                ?.let { Acquisition(it, request.optString("captureOwner"), epoch) }
        if (job != null) {
            invalidateAcquisitions(job.owner)
            acquisitions[job.owner] = job
            job.hit = { event ->
                views().any { view ->
                    val bounds = Rect()
                    val location = IntArray(2)
                    view.rootView.getLocationOnScreen(location)
                    val visible = view.isShown && view.getGlobalVisibleRect(bounds)
                    bounds.offset(location[0], location[1])
                    visible && bounds.contains(event.rawX.toInt(), event.rawY.toInt())
                }
            }
            if (request.optBoolean("stopScrollBeforeCapture"))
                job.stop = { event ->
                    val contact = MotionEvent.obtain(event)
                    val origin = IntArray(2)
                    reference.getLocationOnScreen(origin)
                    try {
                        contact.setLocation(event.rawX - origin[0], event.rawY - origin[1])
                        reference.onTouchEvent(contact)
                        contact.action = MotionEvent.ACTION_CANCEL
                        reference.onTouchEvent(contact)
                    } finally {
                        contact.recycle()
                    }
                }
            interactionListener?.invoke(
                JSONObject()
                    .put("active", touching)
                    .put("capturePolicy", "preinteraction")
                    .put("prepareDuringInteraction", true)
            )
        }
        prepareCapture(
            window,
            reference,
            request.optDouble("viewportWidth"),
            frames,
            sourceViews = sourceViews,
            contentRevision = request.optLong("revision"),
            acquisition = job,
            delay = request.optLong("captureDelayMs", 0).coerceAtLeast(0),
            complete = complete,
        )
    }

    private fun prepareCapture(
        window: Window,
        reference: View,
        viewportWidth: Double,
        frames: () -> Map<String, RectF>,
        sourceViews: (() -> Map<String, View>)? = null,
        contentRevision: Long = 0,
        acquisition: Acquisition? = null,
        delay: Long = 0,
        complete: (JSONObject) -> Unit,
    ) {
        onMain()
        if (
            !supported ||
                closed ||
                (acquisition == null && (pending || touching)) ||
                viewportWidth <= 0 ||
                !viewportWidth.isFinite() ||
                reference.width <= 0
        ) {
            if (acquisition != null && acquisitions[acquisition.owner] === acquisition)
                acquisitions.remove(acquisition.owner)
            complete(JSONObject())
            return
        }
        if (acquisition == null) pending = true
        val stamp = generation
        val started = SystemClock.uptimeMillis()
        var finished = false
        var attempt = 0
        fun current() =
            !closed &&
                !finished &&
                (acquisition == null || acquisition.epoch == epoch) &&
                (acquisition?.pinned == true ||
                    (!touching && (acquisition != null || generation == stamp)))
        fun finish(result: JSONObject) {
            if (finished) return
            finished = true
            if (acquisition == null) pending = false
            acquisition?.run = null
            acquisition?.cancel = null
            acquisition?.let { job ->
                job.token = result.optString("token").takeIf { it.isNotEmpty() }
                if (!result.has("token") && acquisitions[job.owner] === job)
                    acquisitions.remove(job.owner)
                finishContact(job)
            }
            complete(result)
        }
        fun fail() = finish(JSONObject())
        acquisition?.cancel = { fail() }
        lateinit var sample: (Map<String, RectF>, Int) -> Unit
        fun acquire() {
            val ticket = ++attempt
            val valid = { current() && ticket == attempt }
            fun readPixels() {
                if (!valid()) return
                val currentFrames =
                    try {
                        frames()
                    } catch (_: RuntimeException) {
                        fail()
                        return
                    }
                if (currentFrames.isEmpty()) {
                    fail()
                    return
                }
                capture(
                    window,
                    reference,
                    viewportWidth,
                    currentFrames,
                    valid,
                    sourceViews?.invoke(),
                    contentRevision,
                    acquired = {
                        acquisition?.pixels = true
                        acquisition?.run = null
                        acquisition?.let(::finishContact)
                    },
                ) {
                    if (ticket == attempt) {
                        if (
                            !it.has("token") &&
                                acquisition != null &&
                                !acquisition.pinned &&
                                touching &&
                                !finished
                        )
                            main.postDelayed({ sample(emptyMap(), 0) }, 16)
                        else finish(it)
                    }
                }
            }
            // A contact restarts an in-flight idle copy after Chromium has stopped.
            if (acquisition != null && reference is WebView)
                NativeUIWebReadiness.prepare(reference, valid) {
                    if (it) readPixels() else if (valid()) fail()
                }
            else readPixels()
        }
        acquisition?.run = { acquire() }
        sample =
            fun(previous: Map<String, RectF>, stable: Int) {
                if (finished || acquisition?.pinned == true) return
                if (acquisition != null && touching) {
                    main.postDelayed({ sample(previous, stable) }, 16)
                    return
                }
                if (
                    !current() || SystemClock.uptimeMillis() - started >= maxOf(1000, delay + 1000)
                ) {
                    fail()
                    return
                }
                val current =
                    try {
                        frames().mapValues { RectF(it.value) }
                    } catch (_: Exception) {
                        fail()
                        return
                    }
                if (current.isEmpty() || current.any { it.key.isEmpty() || !it.value.valid() }) {
                    fail()
                    return
                }
                val count = if (current == previous) stable + 1 else 0
                if (
                    count < 3 ||
                        SystemClock.uptimeMillis() - (acquisition?.changedAt ?: started) < delay
                ) {
                    main.postDelayed({ sample(current, count) }, 16)
                    return
                }
                acquire()
            }
        // Stable native bounds do not imply that the Web background has painted.
        // Prepare the Web draw before measuring/capturing the composited window.
        if (reference is WebView && acquisition == null) {
            NativeUIWebReadiness.prepare(reference, { current() }) { ready ->
                if (ready) sample(emptyMap(), 0) else fail()
            }
        } else sample(emptyMap(), 0)
    }

    private fun capture(
        window: Window,
        reference: View,
        viewportWidth: Double,
        frames: Map<String, RectF>,
        current: () -> Boolean,
        sourceViews: Map<String, View>?,
        contentRevision: Long,
        acquired: () -> Unit,
        complete: (JSONObject) -> Unit,
    ) {
        if (Build.VERSION.SDK_INT < 26) {
            complete(JSONObject())
            return
        }
        val root = window.decorView
        val location = origin(reference)
        val ratio = viewportWidth / reference.width
        val width = root.width
        val height = root.height
        val referenceWidth = reference.width
        val referenceHeight = reference.height
        fun deliver(parts: List<Part>, reused: Boolean = false) {
            val token = UUID.randomUUID().toString()
            captures[token] =
                Capture(width, height, location, referenceWidth, referenceHeight, parts)
            complete(
                JSONObject()
                    .put("token", token)
                    .put("reused", reused)
                    .put(
                        "parts",
                        JSONArray(
                            parts.map { part ->
                                JSONObject()
                                    .put("ids", JSONArray(listOf(part.id)))
                                    .put("url", Uri.fromFile(part.file).toString())
                                    .put(
                                        "anchorBounds",
                                        JSONObject().apply {
                                            val anchor = frames.getValue(part.id)
                                            put("x", (anchor.left - part.frame.left) * ratio)
                                            put("y", (anchor.top - part.frame.top) * ratio)
                                            put("width", anchor.width() * ratio)
                                            put("height", anchor.height() * ratio)
                                        },
                                    )
                                    .put("x", part.frame.left * ratio)
                                    .put("y", part.frame.top * ratio)
                                    .put("width", part.frame.width() * ratio)
                                    .put("height", part.frame.height() * ratio)
                            }
                        ),
                    )
            )
        }
        val regions =
            frames.mapValues { (_, frame) ->
                if (sourceViews != null)
                    Rect(
                        floor(frame.left + location[0].toDouble()).toInt(),
                        floor(frame.top + location[1].toDouble()).toInt(),
                        ceil(frame.right + location[0].toDouble()).toInt(),
                        ceil(frame.bottom + location[1].toDouble()).toInt(),
                    )
                else
                    Rect(
                        floor(frame.left + location[0] - 12.0).toInt().coerceAtLeast(0),
                        floor(frame.top + location[1] - 12.0).toInt().coerceAtLeast(0),
                        ceil(frame.right + location[0] + 12.0).toInt().coerceAtMost(width),
                        ceil(frame.bottom + location[1] + 12.0).toInt().coerceAtMost(height),
                    )
            }
        val states = sourceViews?.mapValues { viewState(it.value) }
        val cached = viewCache
        // Compare raster crop coordinates: shared-canvas overlap must stay unchanged.
        val sameArrangement =
            cached != null &&
                cached.views.keys.toList() == sourceViews?.keys?.toList() &&
                cached.parts.size == frames.size &&
                sameViewCaptureArrangement(cached.regions, regions)
        if (
            sourceViews != null &&
                cached != null &&
                cached.revision == contentRevision &&
                cached.views == sourceViews &&
                cached.window.get() === window &&
                cached.states == states &&
                sourceViews.keys == frames.keys &&
                sameArrangement &&
                sourceViews.values.none { it.isLayoutRequested } &&
                cached.parts.all { part ->
                    part.file.isFile &&
                        frames[part.id]?.let {
                            it.width() == part.frame.width() && it.height() == part.frame.height()
                        } == true
                }
        ) {
            acquired()
            deliver(
                cached.parts.map { it.copy(frame = RectF(frames.getValue(it.id))) },
                reused = true,
            )
            return
        }
        if (regions.any { it.value.isEmpty }) {
            complete(JSONObject())
            return
        }
        val union = Rect().also { rect -> regions.values.forEach { rect.union(it) } }
        if (
            union.width().toLong() * union.height() > 8_000_000 ||
                regions.values.sumOf { it.width().toLong() * it.height() } > 8_000_000
        ) {
            complete(JSONObject())
            return
        }
        val pixels =
            try {
                Bitmap.createBitmap(union.width(), union.height(), Bitmap.Config.ARGB_8888)
            } catch (_: RuntimeException) {
                complete(JSONObject())
                return
            }
        try {
            val acceptPixels: (Int) -> Unit = accept@{ result ->
                if (result != PixelCopy.SUCCESS || !current()) {
                    pixels.recycle()
                    complete(JSONObject())
                    return@accept
                }
                acquired()
                val token = UUID.randomUUID().toString()
                encoder.execute {
                    val parts = mutableListOf<Part>()
                    try {
                        directory.mkdirs()
                        val tasks =
                            regions.entries.mapIndexed { index, (id, rect) ->
                                Callable {
                                    val image =
                                        Bitmap.createBitmap(
                                            pixels,
                                            rect.left - union.left,
                                            rect.top - union.top,
                                            rect.width(),
                                            rect.height(),
                                        )
                                    val file = File(directory, "$token-$index.png")
                                    try {
                                        check(
                                            file.outputStream().use { NativeUIPng.write(image, it) }
                                        )
                                        Part(
                                            id,
                                            RectF(
                                                rect.left - location[0].toFloat(),
                                                rect.top - location[1].toFloat(),
                                                rect.right - location[0].toFloat(),
                                                rect.bottom - location[1].toFloat(),
                                            ),
                                            image,
                                            file,
                                        )
                                    } catch (error: Exception) {
                                        if (image !== pixels) image.recycle()
                                        file.delete()
                                        throw error
                                    }
                                }
                            }
                        val workerLimit = 2
                        val parallel =
                            workerLimit > 1 &&
                                tasks.size > 1 &&
                                regions.values.all { it.width().toLong() * it.height() <= 500_000 }
                        if (parallel) {
                            // Join every task even after a failure before recycling shared pixels.
                            val futures = tasks.map { pngWorkers.submit(it) }
                            var interrupted = false
                            for (future in futures) {
                                var joined = false
                                while (!joined) {
                                    try {
                                        parts.add(future.get())
                                        joined = true
                                    } catch (_: InterruptedException) {
                                        interrupted = true
                                    } catch (_: Exception) {
                                        joined = true
                                    }
                                }
                            }
                            if (interrupted) Thread.currentThread().interrupt()
                            check(parts.size == tasks.size)
                        } else {
                            for (task in tasks) parts.add(task.call())
                        }
                    } catch (_: Exception) {
                        parts.forEach {
                            it.file.delete()
                            if (it.bitmap !== pixels) it.bitmap.recycle()
                        }
                        parts.clear()
                    }
                    main.post {
                        if (
                            !current() ||
                                root.width != width ||
                                root.height != height ||
                                origin(reference) != location ||
                                reference.width != referenceWidth ||
                                reference.height != referenceHeight ||
                                parts.size != regions.size
                        ) {
                            parts.forEach {
                                it.file.delete()
                                if (it.bitmap !== pixels) it.bitmap.recycle()
                            }
                            pixels.recycle()
                            complete(JSONObject())
                            return@post
                        }
                        // A full-bounds crop may share pixels; keep that bitmap until token
                        // release.
                        if (parts.none { it.bitmap === pixels }) pixels.recycle()
                        val previous = viewCache
                        if (sourceViews != null)
                            viewCache =
                                ViewCache(
                                    contentRevision,
                                    sourceViews.toMap(),
                                    regions.mapValues { Rect(it.value) },
                                    WeakReference(window),
                                    states.orEmpty(),
                                    parts,
                                )
                        previous?.parts?.forEach(::releasePixelsIfUnused)
                        deliver(parts)
                    }
                }
            }
            if (sourceViews == null) PixelCopy.request(window, union, pixels, acceptPixels, main)
            else {
                check(sourceViews.keys == frames.keys)
                val canvas = Canvas(pixels)
                for ((id, view) in sourceViews) {
                    val rect = regions.getValue(id)
                    val save = canvas.save()
                    canvas.translate(
                        (rect.left - union.left).toFloat(),
                        (rect.top - union.top).toFloat(),
                    )
                    canvas.clipRect(0, 0, view.width, view.height)
                    view.draw(canvas)
                    canvas.restoreToCount(save)
                }
                acceptPixels(PixelCopy.SUCCESS)
            }
        } catch (_: RuntimeException) {
            pixels.recycle()
            complete(JSONObject())
        }
    }

    private fun valid(token: String, window: Window, reference: View): Capture? =
        captures[token]?.takeIf {
            window.decorView.width == it.width &&
                window.decorView.height == it.height &&
                origin(reference) == it.origin &&
                reference.width == it.referenceWidth &&
                reference.height == it.referenceHeight
        }

    fun cover(
        token: String,
        window: Window,
        reference: View,
        views: List<View>,
        transient: Boolean = false,
        clips: Map<String, RectF>? = null,
        frames: Map<String, RectF>? = null,
    ): Boolean {
        onMain()
        // Composite pixels cover both the live translucent view and its Web replacement.
        // Install the entry copy before changing native visibility in the same UI turn.
        expiredEntries.remove(token)
        if (!restore(token, window, reference, frames = frames, entry = true, clips = clips))
            return false
        if (!transient) coveringToken = token
        hide(token, views)
        return true
    }

    /** Opaque pixels already painted in Web need no composited native overlay. */
    internal fun discardViewBitmaps(token: String) {
        onMain()
        check(copy == null) { "Composited handoff pixels are still in use" }
        captures[token]?.parts?.forEach { if (!it.bitmap.isRecycled) it.bitmap.recycle() }
    }

    fun coverView(token: String, window: Window, reference: View, views: List<View>): Boolean {
        onMain()
        if (valid(token, window, reference) == null) return false
        hide(token, views)
        return true
    }

    private fun hide(token: String, views: List<View>) {
        onMain()
        restoreViews()
        generation++
        hidden =
            token to
                views
                    .map { it to it.visibility }
                    .also { saved -> saved.forEach { it.first.visibility = View.INVISIBLE } }
    }

    fun restoreViews() {
        onMain()
        hidden?.second?.forEach { (view, visibility) -> view.visibility = visibility }
        hidden = null
    }

    fun identifiers(token: String): Set<String> =
        captures[token]?.parts?.map { it.id }?.toSet() ?: emptySet()

    fun restore(
        token: String,
        window: Window,
        reference: View,
        frames: Map<String, RectF>? = null,
        entry: Boolean = false,
        clips: Map<String, RectF>? = null,
    ): Boolean {
        onMain()
        val capture = valid(token, window, reference) ?: return false
        if (
            frames != null &&
                capture.parts.any { part ->
                    val frame = frames[part.id]
                    frame?.valid() != true ||
                        kotlin.math.abs(frame.width() - part.frame.width()) > 0.1f ||
                        kotlin.math.abs(frame.height() - part.frame.height()) > 0.1f
                }
        )
            return false
        clearCopy()
        val root = window.decorView as? ViewGroup ?: return false
        val rootLocation = origin(root)
        val sourceLocation = origin(reference)
        val views =
            capture.parts.map { part ->
                val frame = RectF(part.frame)
                frames?.get(part.id)?.let { current ->
                    val original = part.frame
                    frame.offset(current.left - original.left, current.top - original.top)
                }
                frame.offset(
                    (sourceLocation[0] - rootLocation[0]).toFloat(),
                    (sourceLocation[1] - rootLocation[1]).toFloat(),
                )
                ImageView(reference.context).also { view ->
                    view.setImageBitmap(part.bitmap)
                    view.scaleType = ImageView.ScaleType.FIT_XY
                    view.isClickable = false
                    view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    view.layout(
                        floor(frame.left.toDouble()).toInt(),
                        floor(frame.top.toDouble()).toInt(),
                        ceil(frame.right.toDouble()).toInt(),
                        ceil(frame.bottom.toDouble()).toInt(),
                    )
                    clips?.get(part.id)?.let { clip ->
                        val clipInRoot = RectF(clip)
                        clipInRoot.offset(
                            (sourceLocation[0] - rootLocation[0]).toFloat(),
                            (sourceLocation[1] - rootLocation[1]).toFloat(),
                        )
                        view.clipBounds =
                            Rect(
                                ceil(clipInRoot.left - frame.left.toDouble())
                                    .toInt()
                                    .coerceAtLeast(0),
                                ceil(clipInRoot.top - frame.top.toDouble())
                                    .toInt()
                                    .coerceAtLeast(0),
                                floor(clipInRoot.right - frame.left.toDouble())
                                    .toInt()
                                    .coerceAtMost(view.width),
                                floor(clipInRoot.bottom - frame.top.toDouble())
                                    .toInt()
                                    .coerceAtMost(view.height),
                            )
                    }
                    root.overlay.add(view)
                }
            }
        val current = Copy(token, entry, root, views)
        copy = current
        main.postDelayed(
            {
                if (copy === current) {
                    if (current.entry) {
                        expiredEntries.add(token)
                        restoreViews()
                    }
                    clearCopy()
                }
            },
            500,
        )
        return true
    }

    fun retireCopyAfterWebDraw(token: String, webView: WebView, complete: (Boolean) -> Unit) =
        retireCopyAfterWebDraw(token, webView, true, complete)

    internal fun retireCopyAfterWebDraw(
        token: String,
        webView: WebView,
        entry: Boolean,
        complete: (Boolean) -> Unit,
    ) {
        onMain()
        if (entry && token in expiredEntries) {
            complete(false)
            return
        }
        val expected = copy
        if (expected == null || expected.token != token || expected.entry != entry) {
            complete(true)
            return
        }
        NativeUIWebReadiness.prepare(webView, { !closed && copy === expected }) { ready ->
            if (!ready) {
                complete((!entry || token !in expiredEntries) && copy !== expected)
                return@prepare
            }
            val observer = webView.viewTreeObserver
            var done = false
            lateinit var listener: android.view.ViewTreeObserver.OnDrawListener
            fun finish(success: Boolean) {
                if (done) return
                done = true
                if (observer.isAlive) observer.removeOnDrawListener(listener)
                if (success && copy === expected) retireCopy(token, entry)
                complete((!entry || token !in expiredEntries) && (success || copy !== expected))
            }
            listener =
                android.view.ViewTreeObserver.OnDrawListener { webView.post { finish(true) } }
            observer.addOnDrawListener(listener)
            webView.invalidate()
            webView.postDelayed({ finish(false) }, 250)
        }
    }

    fun retireCopy(token: String, entry: Boolean = true) {
        onMain()
        if (copy?.token == token && copy?.entry == entry) clearCopy()
    }

    private fun clearCopy() {
        copy?.let { current -> current.views.forEach { current.root.overlay.remove(it) } }
        copy = null
    }

    fun dismiss() {
        onMain()
        generation++
        clearCopy()
        restoreViews()
        coveringToken = null
    }

    fun finishCovering() {
        onMain()
        coveringToken = null
    }

    private fun releasePixelsIfUnused(part: Part) {
        if (
            viewCache?.parts?.any { it.bitmap === part.bitmap } == true ||
                captures.values.any { capture -> capture.parts.any { it.bitmap === part.bitmap } }
        )
            return
        part.file.delete()
        if (!part.bitmap.isRecycled) part.bitmap.recycle()
    }

    fun release(token: String) {
        expiredEntries.remove(token)
        onMain()
        if (hidden?.first == token) restoreViews()
        if (coveringToken == token) coveringToken = null
        if (copy?.token == token) clearCopy()
        acquisitions.values
            .toList()
            .filter { it.token == token }
            .forEach { invalidateAcquisitions(it.owner) }
        captures.remove(token)?.parts?.forEach(::releasePixelsIfUnused)
    }

    fun reset() {
        onMain()
        epoch++
        acquisitions.values.toList().forEach { it.cancel?.invoke() }
        acquisitions.clear()
        generation++
        touching = false
        val previous = viewCache
        viewCache = null
        restoreViews()
        captures.keys.toList().forEach(::release)
        previous?.parts?.forEach(::releasePixelsIfUnused)
    }

    override fun close() {
        onMain()
        closed = true
        stopObserver?.invoke()
        stopObserver = null
        reset()
        encoder.shutdown()
    }
}
