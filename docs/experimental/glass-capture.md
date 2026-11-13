# Experimental Liquid Glass capture workaround

On iOS 26 and later, `NativeUICoveredSnapshots.experimentalInPlaceFilteringEnabled` defaults to **true**. This workaround uses a **private Apple API** to preserve Liquid Glass appearance in cold-launch captures. It carries App Store review and OS compatibility risks. Applications can disable it before registering controls:

```swift
import WebViewNativeUIEngine

NativeUICoveredSnapshots.experimentalInPlaceFilteringEnabled = false
```

The option is process-wide. Configure it at startup; changing it while retaining cached captures does not invalidate those images. Disabling it restores the original drawing path and timing. The helper remains compiled into the dependency when disabled, so disabling execution is not an App Store acceptance guarantee. Before iOS 26, the workaround is not invoked.

The enabled path temporarily sets `allowsInPlaceFiltering` on backdrop layers with a `glassBackground` filter and uses `afterScreenUpdates: true`, including pre-interaction acquisition. Both are needed for the tested cold-launch issue. Each original value is recorded before mutation and restored in `@finally`; originally enabled values remain unchanged. No lifecycle hook or additional swizzling is installed by this workaround.

Setting and drawing run synchronously on main inside Objective-C++. Unsupported layers draw normally; getter/setter exceptions restore partial changes before falling back to normal drawing. Drawing exceptions return failure after restoration without unwinding a Swift callback. Background and reentrant calls are rejected, and option access is protected by a lock. If a restoration setter throws, remaining restorations are attempted, the capture is rejected, and future mutation is disabled for that process. This cannot guarantee recovery from a setter that refuses restoration, or catch `EXC_BAD_ACCESS`, failed symbol resolution, or process termination.

Physical iPhone 15 Pro Max / iOS 27.2.1 tests covered independent cold launches, normal and scheduled pre-interaction engine capture, PNG decoding and UIImage projection. Grayscale ROI error against the native OS screenshot decreased from approximately 0.0143 disabled to 0.00051 enabled; colored content was approximately 0.00036 enabled. Flags were restored after every capture. These are RGB differences, not measured physical alpha values. Single scheduled pixel-acquisition samples were approximately 14.3 ms disabled and 23.0 ms enabled; update waiting can increase latency. This is not a touch-promotion benchmark or certification for all OS versions and views.
