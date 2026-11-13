#import "NativeUIGlassCapture.h"

// Objective-C++ enables ARC exception cleanup without unsafe SwiftPM compiler flags.
// Private implementation details: skipped when the host disables the workaround.
static BOOL restore(NSArray<NSArray *> *states) {
    BOOL restored = YES;
    for (NSArray *state in states.reverseObjectEnumerator) {
        @try { [state[0] setValue:state[1] forKey:@"allowsInPlaceFiltering"]; }
        @catch (NSException *exception) { restored = NO; }
    }
    return restored;
}

static void prepare(CALayer *layer, NSMutableArray<NSArray *> *states) {
    if ([layer respondsToSelector:NSSelectorFromString(@"allowsInPlaceFiltering")] &&
        [layer respondsToSelector:NSSelectorFromString(@"setAllowsInPlaceFiltering:")]) {
        for (id filter in layer.filters) {
            if (![[filter valueForKey:@"type"] isEqual:@"glassBackground"]) continue;
            id original = [layer valueForKey:@"allowsInPlaceFiltering"];
            if (![original isKindOfClass:NSNumber.class] || [original boolValue]) break;
            // Record before writing, including setters that mutate and then throw.
            [states addObject:@[layer, original]];
            [layer setValue:@YES forKey:@"allowsInPlaceFiltering"];
            break;
        }
    }
    for (CALayer *child in layer.sublayers.copy) prepare(child, states);
}

static BOOL drawSafely(BOOL (^draw)(void)) {
    @try { return draw(); }
    @catch (NSException *exception) { return NO; }
}

BOOL NUICaptureWithInPlaceFiltering(CALayer *root, BOOL (^draw)(void)) {
    // All mutation is synchronous on main. Reject reentry even on the same thread.
    static BOOL capturing = NO;
    static BOOL disabledAfterRestoreFailure = NO;
    if (!NSThread.isMainThread || capturing) return NO;
    capturing = YES;
    @try {
        if (disabledAfterRestoreFailure) return drawSafely(draw);
        NSMutableArray<NSArray *> *states = [NSMutableArray array];
        @try { prepare(root, states); }
        @catch (NSException *exception) {
            if (!restore(states)) { disabledAfterRestoreFailure = YES; return NO; }
            return drawSafely(draw);
        }
        BOOL drawn = NO;
        BOOL restored = NO;
        @try { drawn = drawSafely(draw); }
        @finally {
            restored = restore(states);
            if (!restored) disabledAfterRestoreFailure = YES;
        }
        // Do not publish an image when restoration failed. Future draws skip mutation.
        return drawn && restored;
    }
    @finally { capturing = NO; }
}

BOOL NUICaptureHierarchyWithInPlaceFiltering(UIWindow *window, NSArray<UIView *> *roots, BOOL afterScreenUpdates) {
    if (!NSThread.isMainThread) return NO;
    // Do not pass a Swift closure through an NSException unwind. Drawing stays here.
    return NUICaptureWithInPlaceFiltering(window.layer, ^BOOL {
        if (!roots) return [window drawViewHierarchyInRect:window.bounds afterScreenUpdates:afterScreenUpdates];
        BOOL drawn = YES;
        for (UIView *root in roots) {
            drawn = [root drawViewHierarchyInRect:[root convertRect:root.bounds toView:window]
                              afterScreenUpdates:YES] && drawn;
        }
        return drawn;
    });
}
