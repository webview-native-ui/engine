# Configure capture timing

Use this when a successful state change is reported before its visual animation
ends. For example, a tab-selection event can arrive while the highlight is still
enlarged; capturing immediately would preserve that intermediate shape beneath
the next Web overlay. Delay background preparation until the control settles.
Keep the default when the measured appearance is already settled; a longer delay
also keeps the previous image available for longer.

`captureDelayMs` is an optional registration setting shared by Capacitor and Cordova.
It defaults to **50 milliseconds** on iOS, Android and the lower-level `createWebProjection`
options. Values must be finite and nonnegative. It uses the existing debounce: a new
update or interaction restarts preparation after activity settles. It does not add a
second timer or delay the overlay's presentation.

Until replacement pixels are ready, the last completed image remains available. If
there is no completed image, normal Web fallback applies. Opening an overlay during
the debounce does not wait for a new capture. Consequently, increasing the delay also
increases the period in which the previous appearance may be used after an update.

A starting recommendation for **UITabBar Liquid Glass selection animations is 600 ms**.
In iOS 27.0 iPhone and iOS 27.1 Duo simulator comparisons, 50 ms captured an enlarged
selection, 300 ms still retained a small residual change, and 600 ms matched the settled
appearance observed at 1000 ms. This is a recommendation for that interaction, not an
Apple timing contract or a universal Liquid Glass duration. Measure your control's
selection, reselection and successive updates before choosing a value. Continuously
changing content has no guaranteed settled snapshot.
