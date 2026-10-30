package io.github.webview_native_ui.engine

import android.content.Context
import java.io.FileNotFoundException
import java.net.URI
import java.util.Locale
import org.json.JSONObject

internal object ProjectionOrigins {
    val defaults = setOf("https://localhost", "http://localhost")

    fun configured(context: Context): Set<String> {
        val text =
            try {
                context.assets.open("capacitor.config.json").bufferedReader().use { it.readText() }
            } catch (_: FileNotFoundException) {
                return defaults
            }
        return configured(JSONObject(text))
    }

    fun configured(configuration: JSONObject): Set<String> {
        val server = configuration.optJSONObject("server") ?: return defaults
        val configuredScheme = server.optString("androidScheme", "https")
        val scheme =
            if (
                configuredScheme in
                    setOf("file", "ftp", "ftps", "ws", "wss", "about", "blob", "data")
            )
                "https"
            else configuredScheme
        val host = server.optString("hostname", "localhost")
        val url = URI(server.optString("url", "$scheme://$host"))
        val originScheme = requireNotNull(url.scheme).lowercase(Locale.ROOT)
        val originHost = requireNotNull(url.host).lowercase(Locale.ROOT)
        val defaultPort =
            (originScheme == "https" && url.port == 443) ||
                (originScheme == "http" && url.port == 80)
        return setOf(
            URI(originScheme, null, originHost, if (defaultPort) -1 else url.port, null, null, null)
                .toString()
        )
    }
}
