export * from './types.js';
export * from './dom/geometry.js';
export * from './dom/scroll-placement.js';
export { createWebProjectionScope, type WebProjectionScope } from './projection/scope.js';
export * from './projection/web.js';
export * from './dom/scroll-bindings.js';
export type { ProjectionEvents, ProjectionDestination } from './projection/events.js';
export { getOverlayCoordinator, usesOverlayBackdrop, type OverlayChange, type OverlayOptions } from './dom/overlays.js';
export { getUnprojectedVisibility } from './dom/visibility.js';

export { bindProjectionPlacement, type ProjectionPlacementBinding } from './projection/placement.js';
