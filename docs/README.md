# Documentation

Build Web-driven screens with native controls and capabilities. These guides
explain how to integrate the Engine into a plugin so Web UI and Native UI can
coexist. Start with [the shared model](concepts.md): how a native component belongs in a Web layout,
which layer presents it, and how interaction returns to the live view. Scrolling
and overlays are examples of that coordination, not separate integration models.

Then choose the smallest integration that fits your ownership model. Register a
native view and its DOM container, connect the lifecycle notifications your UI
needs, and add advanced APIs only if you already own a renderer's batching or placement.

## Choose by the problem you need to solve

| Case                                                                                     | Start here                                                                                            | Why                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| An eligible native SDK view belongs in a scrolling Web feed                              | [Basic registration](getting-started/initialization.md) and [platform limits](reference/platforms.md) | Bind it to its DOM container; native tracking or temporary image presentation depends on the platform and layout.   |
| A Web modal must cover a plugin's native tab bar                                         | [Basic registration](getting-started/initialization.md), then the framework integration guide         | Register the view and its DOM host, then connect overlay lifecycle; the Engine coordinates handoff and restoration. |
| A hidden fallback returns with the old toggle selection                                  | [Value bindings](configuration/values.md)                                                             | Reflect current native data on the fallback host, independently of where it is displayed.                           |
| Background toolbar buttons and foreground modal buttons need different handoff lifetimes | [Renderer surfaces](advanced/renderer.md)                                                             | Separate owners so closing one surface cannot restore another's controls.                                           |
| An existing renderer overlaps updates or loses a native acknowledgement                  | [Update queue](advanced/update-queue.md)                                                              | Serialize fresh-state passes and reconcile the connection without replaying user actions.                           |

The full reading order follows. Skip advanced APIs unless your renderer owns the
work described in their cases.

## 1. Understand the approach

[Concepts and limits](concepts.md) explains what projection makes possible, how it
differs from live native UI and Web fallback, and which responsibilities stay with
the plugin.

## 2. Initialize and integrate

Read [basic initialization](getting-started/initialization.md) for the minimum call
and required inputs. Then choose one platform-framework guide:

- [Capacitor plugin](getting-started/capacitor.md): dependencies, native plugin hooks, event forwarding and teardown.
- [Cordova plugin](getting-started/cordova.md): the same registration with Cordova startup and resource handling.

Neither route requires a second application-side Engine wrapper or the advanced
renderer APIs.

## 3. Add optional behavior

[Registration settings](configuration/README.md) lists defaults and the situations
that require each option. Read only the relevant detail:

- [Notifications](configuration/events.md): tell the Engine when appearance or presentation changes.
- [Value bindings](configuration/values.md): keep the fallback host's component data aligned with native state.
- [Capture timing](configuration/capture.md): prepare pixels after native appearance settles.
- [Ionic overlays](configuration/ionic-overlays.md): connect Ionic coverage with one shared application initializer.

## 4. Use advanced APIs when you own a renderer

[Choose an advanced API](advanced/README.md) before adding one. These guides address
different existing renderer needs; they are not a sequence of required setup steps.

- [Page and modal surfaces](advanced/renderer.md)
- [Low-level Web projection and batches](advanced/web-projection.md)
- [Native handoff and scroll bindings](advanced/native-handoff.md)
- [Deferred Android placement](advanced/android-placement.md)
- [Update serialization and recovery](advanced/update-queue.md)

## Reference

Use these to check contracts and supported behavior while implementing either route:

- [Projection contract and lifetime](reference/projection.md)
- [HTML and Ionic container support](reference/containers.md)
- [Observable presentation intent](reference/state.md)
- [Capture and platform limits](reference/platforms.md)

## Contributing

[Development and releases](maintenance.md) covers repository structure, local
verification, CI and publication. It is not required for consuming the Engine.
