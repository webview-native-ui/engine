#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN
/// Experimental private-API workaround. Call synchronously on the main thread.
/// Restores changed values before returning. Unsupported layers use draw unchanged.
/// Returns NO for exceptions, off-main calls, reentry, or failed restoration.
FOUNDATION_EXPORT BOOL NUICaptureWithInPlaceFiltering(CALayer *root, BOOL (^draw)(void));
/// Keeps potentially throwing UIKit calls inside the Objective-C++ exception boundary.
FOUNDATION_EXPORT BOOL NUICaptureHierarchyWithInPlaceFiltering(UIWindow *window, NSArray<UIView *> * _Nullable roots, BOOL afterScreenUpdates);
NS_ASSUME_NONNULL_END
