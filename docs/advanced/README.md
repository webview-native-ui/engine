# Advanced APIs

The basic registration already owns measurement, capture and handoff acknowledgement.
Do not add a second projection manager for the same host. Use the following APIs
when your renderer already owns the corresponding work and needs to coordinate it:

| Need                                                                       | API / guide                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apply deferred native placement just before an opaque Android view returns | `beforeNativeReveal`, `updatePlacement`, `isProjecting` and `bindProjectionPlacement`; see [Android placement handoff](android-placement.md#final-placement-when-returning-from-an-opaque-image-android). Both callbacks default to no custom placement work. |
| Manage independent pages or modals containing multiple native controls     | `createWebProjectionSurface` / `createWebProjectionSurfaces`; see the [renderer guide](renderer.md).                                                                                                                                                          |
| Coordinate several fallback containers in one native transaction           | `createWebProjectionBatch`; see [batch handoff](web-projection.md#multiple-fallbacks-in-one-native-transaction).                                                                                                                                              |
| Fit an existing ownership model that surface helpers cannot express        | `createWebProjectionScope` / `createWebProjection`; see [low-level projection](web-projection.md).                                                                                                                                                            |
| Serialize replaceable state updates and recover a lost acknowledgement     | `createNativeUpdateQueue`; see [update scheduling and recovery](update-queue.md).                                                                                                                                                                             |
| Implement the native bridge for a custom renderer                          | Snapshot-manager `handle` methods; see [native handoff](native-handoff.md).                                                                                                                                                                                   |

These are integration choices, not additional steps to complete a normal
`NativeUIProjection` setup. Keep business actions, SDK interaction and application
notifications in the consuming plugin.

[Documentation overview](../README.md)
