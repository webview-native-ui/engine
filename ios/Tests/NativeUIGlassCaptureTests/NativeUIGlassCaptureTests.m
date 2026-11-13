@import XCTest;
@import UIKit;
@import NativeUIGlassCapture;

@interface TestGlassFilter : NSObject
@property (nonatomic, copy) NSString *type;
@end
@implementation TestGlassFilter
@end

@interface TestGlassLayer : CALayer
@property (nonatomic) BOOL allowsInPlaceFiltering;
@property (nonatomic) BOOL throwsOnEnable;
@property (nonatomic) BOOL throwsOnRead;
@property (nonatomic) BOOL throwsAfterEnable;
@property (nonatomic, copy) NSArray *testFilters;
@end
@implementation TestGlassLayer
@synthesize allowsInPlaceFiltering = _allowsInPlaceFiltering;
- (NSArray *)filters { return self.testFilters; }
- (BOOL)allowsInPlaceFiltering {
    if (self.throwsOnRead) @throw [NSException exceptionWithName:@"read" reason:nil userInfo:nil];
    return _allowsInPlaceFiltering;
}
- (void)setAllowsInPlaceFiltering:(BOOL)value {
    if (value && self.throwsOnEnable) @throw [NSException exceptionWithName:@"write" reason:nil userInfo:nil];
    _allowsInPlaceFiltering = value;
    if (value && self.throwsAfterEnable) @throw [NSException exceptionWithName:@"partialWrite" reason:nil userInfo:nil];
}
@end

@interface ThrowingCaptureWindow : UIWindow
@end
@implementation ThrowingCaptureWindow
- (BOOL)drawViewHierarchyInRect:(CGRect)rect afterScreenUpdates:(BOOL)updates {
    @throw [NSException exceptionWithName:@"UIKitDrawing" reason:nil userInfo:nil];
    return NO;
}
@end

@interface NativeUIGlassCaptureTests : XCTestCase
@end
@implementation NativeUIGlassCaptureTests
- (TestGlassLayer *)glass {
    TestGlassFilter *filter = [TestGlassFilter new]; filter.type = @"glassBackground";
    TestGlassLayer *layer = [TestGlassLayer layer]; layer.testFilters = @[filter]; return layer;
}
- (void)testCaptureScopesMutationAndPreservesOriginallyEnabledState {
    TestGlassLayer *root = [self glass], *child = [self glass];
    child.allowsInPlaceFiltering = YES; [root addSublayer:child];
    __block int draws = 0;
    XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL {
        draws++; XCTAssertTrue(root.allowsInPlaceFiltering); XCTAssertTrue(child.allowsInPlaceFiltering); return YES;
    }));
    XCTAssertEqual(draws, 1); XCTAssertFalse(root.allowsInPlaceFiltering); XCTAssertTrue(child.allowsInPlaceFiltering);
}
- (void)testUnsupportedLayersDrawNormally {
    __block int draws = 0;
    XCTAssertTrue(NUICaptureWithInPlaceFiltering([CALayer layer], ^BOOL { draws++; return YES; }));
    XCTAssertEqual(draws, 1);
}
- (void)testOnlyGlassBackgroundIsChanged {
    TestGlassLayer *root = [self glass]; ((TestGlassFilter *)root.testFilters.firstObject).type = @"gaussianBlur";
    XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL { XCTAssertFalse(root.allowsInPlaceFiltering); return YES; }));
}
- (void)testSetterExceptionRestoresEarlierLayersBeforeFallback {
    TestGlassLayer *root = [self glass], *child = [self glass]; child.throwsOnEnable = YES; [root addSublayer:child];
    __block int draws = 0;
    XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL {
        draws++; XCTAssertFalse(root.allowsInPlaceFiltering); XCTAssertFalse(child.allowsInPlaceFiltering); return YES;
    }));
    XCTAssertEqual(draws, 1);
}
- (void)testPartiallyMutatingSetterIsRestoredBeforeFallback {
    TestGlassLayer *root = [self glass]; root.throwsAfterEnable = YES;
    XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL { XCTAssertFalse(root.allowsInPlaceFiltering); return YES; }));
    XCTAssertFalse(root.allowsInPlaceFiltering);
}
- (void)testGetterExceptionFallsBackOnce {
    TestGlassLayer *root = [self glass]; root.throwsOnRead = YES; __block int draws = 0;
    XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL { draws++; return YES; })); XCTAssertEqual(draws, 1);
}
- (void)testGetterExceptionReleasesLayerReferences {
    __weak TestGlassLayer *released;
    @autoreleasepool {
        TestGlassLayer *root = [self glass]; released = root; root.throwsOnRead = YES;
        XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL { return YES; }));
        root = nil;
    }
    XCTAssertNil(released);
}
- (void)testPartiallyMutatingSetterExceptionReleasesLayerReferences {
    __weak TestGlassLayer *released;
    @autoreleasepool {
        TestGlassLayer *root = [self glass]; released = root; root.throwsAfterEnable = YES;
        XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL { return YES; }));
        root = nil;
    }
    XCTAssertNil(released);
}
- (void)testFailedDrawingStillRestores {
    TestGlassLayer *root = [self glass];
    XCTAssertFalse(NUICaptureWithInPlaceFiltering(root, ^BOOL { return NO; })); XCTAssertFalse(root.allowsInPlaceFiltering);
}
- (void)testDrawingExceptionReturnsFailureAndRestores {
    TestGlassLayer *root = [self glass];
    XCTAssertFalse(NUICaptureWithInPlaceFiltering(root, ^BOOL {
        @throw [NSException exceptionWithName:@"drawing" reason:nil userInfo:nil]; return NO;
    }));
    XCTAssertFalse(root.allowsInPlaceFiltering);
}
- (void)testReentryIsRejectedWithoutChangingOuterState {
    TestGlassLayer *root = [self glass]; __block BOOL nestedDraw = NO;
    XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL {
        XCTAssertFalse(NUICaptureWithInPlaceFiltering(root, ^BOOL { nestedDraw = YES; return YES; }));
        XCTAssertTrue(root.allowsInPlaceFiltering); return YES;
    }));
    XCTAssertFalse(nestedDraw); XCTAssertFalse(root.allowsInPlaceFiltering);
    XCTAssertTrue(NUICaptureWithInPlaceFiltering(root, ^BOOL { return YES; }));
}
- (void)testOffMainCallIsRejectedWithoutDrawing {
    TestGlassLayer *root = [self glass];
    XCTestExpectation *done = [self expectationWithDescription:@"background rejected"];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
        __block BOOL drawn = NO;
        XCTAssertFalse(NUICaptureWithInPlaceFiltering(root, ^BOOL { drawn = YES; return YES; }));
        XCTAssertFalse(drawn); [done fulfill];
    });
    [self waitForExpectationsWithTimeout:3 handler:nil];
    XCTAssertFalse(root.allowsInPlaceFiltering);
}
- (void)testUIKitDrawingExceptionReturnsFailureWithoutEscaping {
    ThrowingCaptureWindow *window = [[ThrowingCaptureWindow alloc] initWithFrame:CGRectMake(0, 0, 100, 100)];
    XCTAssertFalse(NUICaptureHierarchyWithInPlaceFiltering(window, nil, YES));
    XCTAssertFalse(NUICaptureHierarchyWithInPlaceFiltering(window, @[window], NO));
}
@end
