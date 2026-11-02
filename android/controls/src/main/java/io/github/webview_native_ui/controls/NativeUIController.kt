package io.github.webview_native_ui.controls

import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.unit.LayoutDirection
import io.github.webview_native_ui.engine.NativeUIClippedView
import io.github.webview_native_ui.engine.NativeUISnapshots
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Host-independent Compose control lifecycle and rendering. */
class NativeUIController(
    private val activity: android.app.Activity,
    private val webView: android.webkit.WebView,
    private val notifyListeners: (String, JSONObject) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val snapshots by lazy {
        NativeUISnapshots(File(activity.cacheDir, "native-ui-snapshots"))
    }
    private var host: FrameLayout? = null
    private var revision = 0L
    private var sequence = 0L
    private var paused = false
    private val entries = linkedMapOf<String, Entry>()
    private val pending = mutableMapOf<String, (Boolean) -> Unit>()
    private val layoutListener =
        View.OnLayoutChangeListener { _, l, t, r, b, oldL, oldT, oldR, oldB ->
            if (l != oldL || t != oldT || r != oldR || b != oldB) {
                snapshots.reset()
                host?.visibility = View.INVISIBLE
                failActions()
                notifyListeners("webViewMetricsChange", JSONObject().put("radius", 0))
            }
        }

    private class Entry(val view: ComposeView, var node: ExtensionNode) {
        val clip = NativeUIClippedView(view)
        val content = mutableStateOf<(@Composable () -> Unit)?>(null)
    }

    fun load() {
        activity.runOnUiThread { webView.addOnLayoutChangeListener(layoutListener) }
    }

    fun configure(data: JSONObject, resolve: (JSONObject) -> Unit, reject: (String) -> Unit) =
        onMain(reject) {
            clearViews()
            revision = 0
            sequence = 0
            resolve(
                JSONObject()
                    .put("supported", true)
                    .put("coveredSnapshots", snapshots.supported)
                    .put("extensions", org.json.JSONArray(NativeUI.renderers.keys.toList()))
            )
        }

    fun getWebViewMetrics(
        data: JSONObject,
        resolve: (JSONObject) -> Unit,
        reject: (String) -> Unit,
    ) = resolve(JSONObject().put("radius", 0))

    fun update(data: JSONObject, resolve: (JSONObject) -> Unit, reject: (String) -> Unit) =
        onMain(reject) {
            val snapshot = NativeUISnapshot.parse(data)
            require(snapshot.revision > revision) { "Stale Native UI snapshot" }
            val web = webView
            val parent = web.parent as? ViewGroup ?: error("WebView has no host")
            require(web.width > 0 && web.height > 0 && web.scaleX == 1f && web.scaleY == 1f) {
                "WebView geometry unavailable"
            }
            val scale = web.width / snapshot.viewportWidth
            val dpScale = scale / web.resources.displayMetrics.density
            val accepted = linkedMapOf<String, Pair<ExtensionNode, @Composable () -> Unit>>()
            val rejected = snapshot.rejected.toMutableList()
            for (node in snapshot.nodes) {
                val renderer = NativeUI.renderers[node.name]
                if (renderer == null || paused) {
                    rejected.add(node.id)
                    continue
                }
                try {
                    val f = node.frame
                    require(
                        listOf(f.x * scale, f.y * scale, f.width * scale, f.height * scale).all {
                            it in -1_000_000.0..1_000_000.0
                        }
                    )
                    val context =
                        NativeUIContext(
                            node.id,
                            f,
                            NativeUIFrame(
                                f.x * dpScale,
                                f.y * dpScale,
                                f.width * dpScale,
                                f.height * dpScale,
                            ),
                            snapshot.viewportWidth,
                            dpScale,
                            node.dark,
                            node.rtl,
                        )
                    val actions =
                        NativeUIActions(node.actions.keys) { action -> activate(node, action) }
                    accepted[node.id] = node to renderer(JSONObject(node.props), actions, context)
                } catch (_: Exception) {
                    rejected.add(node.id)
                }
            }
            snapshots.restoreViews()
            val coveredToken = data.optString("coveredSnapshotToken").takeIf { it.isNotEmpty() }
            if (coveredToken == null) {
                snapshots.coveringToken?.let { snapshots.restore(it, activity.window, web) }
                snapshots.finishCovering()
            }
            snapshots.changed()
            revision = snapshot.revision
            val container =
                host
                    ?: FrameLayout(activity).also {
                        it.clipChildren = true
                        it.clipToPadding = true
                        parent.addView(it, ViewGroup.LayoutParams(web.width, web.height))
                        host = it
                    }
            if (
                container.layoutParams.width != web.width ||
                    container.layoutParams.height != web.height
            )
                container.layoutParams =
                    container.layoutParams.apply {
                        width = web.width
                        height = web.height
                    }
            container.x = web.x
            container.y = web.y
            for (id in entries.keys.toList()) if (id !in accepted) removeEntry(id)
            for ((id, pair) in accepted) {
                val (node, content) = pair
                val entry =
                    entries[id]
                        ?: Entry(ComposeView(activity), node).also { entry ->
                            entry.view.setViewCompositionStrategy(
                                ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed
                            )
                            entry.clip.interaction = { active ->
                                snapshots.interaction(active)
                                notifyListeners(
                                    "snapshotInteraction",
                                    JSONObject().put("active", active),
                                )
                            }
                            container.addView(entry.clip)
                            entry.view.setContent { entry.content.value?.invoke() }
                            entries[id] = entry
                        }
                entry.node = node
                entry.content.value = {
                    CompositionLocalProvider(
                        LocalLayoutDirection provides
                            if (node.rtl) LayoutDirection.Rtl else LayoutDirection.Ltr
                    ) {
                        content()
                    }
                }
                val f = node.frame
                entry.clip.place(
                    RectF(
                        (f.x * scale).toFloat(),
                        (f.y * scale).toFloat(),
                        ((f.x + f.width) * scale).toFloat(),
                        ((f.y + f.height) * scale).toFloat(),
                    ),
                    RectF(0f, 0f, web.width.toFloat(), web.height.toFloat()),
                )
            }
            container.visibility = if (paused) View.INVISIBLE else View.VISIBLE
            resolve(
                JSONObject()
                    .put("revision", revision)
                    .put("rejectedControls", org.json.JSONArray(rejected))
            )
        }

    fun coveredSnapshot(data: JSONObject, resolve: (JSONObject) -> Unit, reject: (String) -> Unit) =
        onMain(reject) {
            val web = webView
            snapshots.handle(
                data,
                activity.window,
                web,
                frames = { ids, requestedRevision ->
                    val frames = linkedMapOf<String, RectF>()
                    if (
                        !paused &&
                            requestedRevision == revision.toLong() &&
                            entries.keys.containsAll(ids)
                    ) {
                        for (id in ids) {
                            val view = entries[id]?.clip ?: break
                            if (!view.isShown || view.isLayoutRequested) break
                            val location = IntArray(2)
                            val origin = IntArray(2)
                            view.getLocationInWindow(location)
                            web.getLocationInWindow(origin)
                            frames[id] =
                                RectF(
                                    (location[0] - origin[0]).toFloat(),
                                    (location[1] - origin[1]).toFloat(),
                                    (location[0] - origin[0] + view.width).toFloat(),
                                    (location[1] - origin[1] + view.height).toFloat(),
                                )
                        }
                    }
                    frames
                },
                views = { ids ->
                    if (paused || !entries.keys.containsAll(ids)) null
                    else ids.map { entries.getValue(it).clip }
                },
            ) { result ->
                result.fold(
                    onSuccess = { resolve(JSONObject(it.toString())) },
                    onFailure = { reject(it.message ?: "Image handoff failed") },
                )
            }
        }

    private suspend fun activate(node: ExtensionNode, name: String): Unit =
        withContext(Dispatchers.Main.immediate) {
            check(
                !paused &&
                    host?.visibility == View.VISIBLE &&
                    entries[node.id]?.clip?.isShown == true &&
                    entries[node.id]?.node == node
            ) {
                "Native UI action is stale"
            }
            val target = node.actions[name] ?: error("Native UI action is unavailable")
            suspendCancellableCoroutine { continuation ->
                val request = UUID.randomUUID().toString()
                val timeout = Runnable { pending.remove(request)?.invoke(false) }
                pending[request] = { accepted ->
                    handler.removeCallbacks(timeout)
                    if (continuation.isActive) {
                        if (accepted) continuation.resume(Unit)
                        else
                            continuation.resumeWithException(
                                IllegalStateException("Native UI action was not accepted")
                            )
                    }
                }
                continuation.invokeOnCancellation {
                    handler.post {
                        pending.remove(request)
                        handler.removeCallbacks(timeout)
                    }
                }
                handler.postDelayed(timeout, 5000)
                notifyListeners(
                    "activate",
                    JSONObject()
                        .put("revision", revision)
                        .put("id", target)
                        .put("sequence", ++sequence)
                        .put("requestId", request),
                )
            }
        }

    fun completeExtensionAction(
        data: JSONObject,
        resolve: (JSONObject) -> Unit,
        reject: (String) -> Unit,
    ) =
        onMain(reject) {
            val request =
                data.optString("requestId").takeIf { it.isNotEmpty() } ?: error("Missing requestId")
            pending.remove(request)?.invoke(data.optBoolean("accepted", false) == true)
            resolve(JSONObject())
        }

    fun clear(data: JSONObject, resolve: (JSONObject) -> Unit, reject: (String) -> Unit) =
        onMain(reject) {
            val next = data.getLong("revision")
            require(next > revision) { "Stale Native UI clear" }
            revision = next
            clearViews()
            resolve(JSONObject())
        }

    private fun onMain(reject: (String) -> Unit, block: () -> Unit) {
        activity.runOnUiThread {
            try {
                block()
            } catch (error: Exception) {
                reject(error.message ?: "Native UI failed")
            }
        }
    }

    private fun failActions() {
        val callbacks = pending.values.toList()
        pending.clear()
        callbacks.forEach { it(false) }
    }

    private fun removeEntry(id: String) {
        entries.remove(id)?.let {
            it.view.disposeComposition()
            host?.removeView(it.clip)
        }
    }

    private fun clearViews() {
        snapshots.reset()
        failActions()
        entries.keys.toList().forEach(::removeEntry)
        (host?.parent as? ViewGroup)?.removeView(host)
        host = null
    }

    fun pause() {
        paused = true
        snapshots.reset()
        host?.visibility = View.INVISIBLE
        failActions()
    }

    fun resume() {
        paused = false
        notifyListeners("webViewMetricsChange", JSONObject().put("radius", 0))
    }

    fun destroy() {
        webView.removeOnLayoutChangeListener(layoutListener)
        clearViews()
        snapshots.close()
    }
}
