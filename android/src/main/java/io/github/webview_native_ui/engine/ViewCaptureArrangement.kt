package io.github.webview_native_ui.engine

import android.graphics.Rect

// Every source is drawn into one shared bitmap before cropping. Cached pixels
// remain valid only when every crop moves by one common integer translation.
internal fun sameViewCaptureArrangement(
    previous: Map<String, Rect>,
    current: Map<String, Rect>,
): Boolean {
    if (previous.isEmpty() || previous.keys.toList() != current.keys.toList()) return false
    val first = previous.keys.first()
    val dx = current.getValue(first).left.toLong() - previous.getValue(first).left
    val dy = current.getValue(first).top.toLong() - previous.getValue(first).top
    return previous.all { (id, before) ->
        val after = current.getValue(id)
        after.left.toLong() - before.left == dx &&
            after.right.toLong() - before.right == dx &&
            after.top.toLong() - before.top == dy &&
            after.bottom.toLong() - before.bottom == dy
    }
}
