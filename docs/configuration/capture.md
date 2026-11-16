# Configure capture timing

Use `captureDelayMs` when a native update is reported before its appearance settles,
such as a tab-selection highlight. It is an optional registration setting shared
by Capacitor and Cordova and the lower-level `createWebProjection` options. The
default is **50 milliseconds**; values must be finite, nonnegative and no greater
than the browser timer limit of 2,147,483,647 ms.

On contact-capable native hosts, the request is armed immediately and native
geometry sampling runs during the configured wait. Contact can promote that
request before the wait ends. Other hosts debounce preparation on Web. A stable
rectangle does not prove that a visual animation has ended.

Until replacement pixels are ready, the previous completed image may remain
available subject to source ownership and layout validity. Opening an overlay
uses an eligible image or Web fallback; it does not wait for the idle debounce.
A longer delay can therefore preserve an earlier appearance for longer.

Choose a delay from the control's selection, reselection and successive-update
behavior. There is no universal Liquid Glass animation duration, and continuously
changing content has no guaranteed settled image. The acquisition order,
interaction policy and timing events are documented once in
[pre-interaction capture](../advanced/preinteraction-capture.md).
