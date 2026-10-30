package io.github.webview_native_ui.engine;

import android.view.View;
import android.view.Window;
import android.webkit.WebView;

// Compilation verifies that Java callers can omit every optional argument.
final class NativeUIProjectionJavaUsage {
    static NativeUIProjection create(Window window, WebView webView, View view) {
        return new NativeUIProjection(window, webView, "Example", "#native-ui-fallback", () -> view);
    }
}
