# Serialize state updates and recover a lost acknowledgement

Use `createNativeUpdateQueue` when a renderer reads DOM state asynchronously and
sends native updates. Event bursts should produce one current-state read, and a
second read must not overlap the previous pass. This helper is optional: it does
not change native registrations or other projection APIs. Keep an existing scheduler
if the renderer needs a different cadence or recovery policy. The queue batches requests on
`requestAnimationFrame`; requests arriving during a pass trigger one later pass.

For example, a resize, a selection update and a DOM mutation arrive in one frame
while the previous native update is still awaiting acknowledgement. Queue one
fresh-state pass instead of starting overlapping reads. If the bridge loses an
acknowledgement, reconcile current state before restoring updates; never use this
queue to retry a purchase, click or advertisement load.

```ts
import { createNativeUpdateQueue } from '@webview-native-ui/engine';

const updates = createNativeUpdateQueue(window, {
  async update(send) {
    const state = await renderer.readCurrentState();
    const reply = await send(
      () => renderer.sendState(state),
      (reply) => {
        if (reply.revision !== state.revision) throw new Error('Revision mismatch');
      },
    );
    if (reply) renderer.accept(state, reply);
  },
  retry: () => renderer.invalidateLastAcceptedState(),
  failed: (error) => renderer.stopAndRestoreFallback(error),
  reconnect: true,
});

// From existing layout/content notifications:
updates.request();
// After the existing connection check has reconciled native session/revision:
updates.reconnected();
// At renderer teardown:
updates.destroy();
```

`renderer` represents the integration's existing code. `send` is only for
replaceable state, called sequentially inside an update pass, never clicks,
selection actions, purchases or SDK requests. A failed send requests one fresh
pass, not a replay of its payload. If that also fails, `reconnect: true` waits for
an external handshake; without it the queue reports terminal failure. An invalid
acknowledgement waits for reconciliation immediately. After reconciliation, another
failed retry or invalid acknowledgement is terminal; a successful send resets the
recovery budget. The queue does not install a connection poller or subscriptions.

Keep operation timeouts in the transport. A timeout does not cancel an underlying
native call: the native renderer must reject stale revisions, and the connection
check must reconcile current state before declaring recovery. Disposal suppresses
late send results and future passes; it cannot undo a native operation already sent.
Use `dirty` to reject obsolete DOM measurements, `running` to defer connection
reconciliation during a pass, and `waiting` to detect a pending recovery. The
renderer still owns revision assignment, accepted geometry and fallback policy.
