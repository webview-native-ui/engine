/*!
 * @webview-native-ui/engine
 * Copyright (c) 2026 Masahiko Sakakibara (rdlabo)
 * SPDX-License-Identifier: MIT
 */

import type { WebProjectionSurface } from './surface.js';

/** Owns asynchronous projection creation and disposal for DOM-backed surfaces. */
export const createWebProjectionSurfaces = <Owner extends Node, Surface extends WebProjectionSurface>(
  options: { ignoreTarget?(element: Element): boolean } = {},
) => {
  type Entry = { surface?: Surface; ready: Promise<Surface | undefined> };
  const entries = new Map<Owner, Entry>();
  const retiring = new Set<Promise<unknown>>();
  const retire = (disposal: Promise<unknown>) => {
    const pending = disposal.finally(() => retiring.delete(pending));
    retiring.add(pending);
    return pending;
  };
  let stopped = false;
  const values = (): Surface[] => [...entries.values()].flatMap((entry) => (entry.surface ? [entry.surface] : []));
  let doc: Document | undefined;
  let listeners: AbortController | undefined;
  let motionFrame = 0;
  const invalidate = () => values().forEach((surface) => surface.invalidate());
  const changed = (owner?: EventTarget) => values().forEach((surface) => surface.changed(owner));
  const observe = (owner: Owner) => {
    const ownerDocument = owner.nodeType === 9 ? (owner as unknown as Document) : owner.ownerDocument!;
    if (doc && doc !== ownerDocument) throw new TypeError('Projection surfaces must share one Document');
    if (doc) return;
    doc = ownerDocument;
    const win = doc.defaultView!;
    listeners = new win.AbortController();
    const subscription = { signal: listeners.signal };
    win.addEventListener('resize', invalidate, subscription);
    win.addEventListener('orientationchange', invalidate, subscription);
    doc.addEventListener(
      'visibilitychange',
      () => {
        if (doc!.hidden) invalidate();
      },
      subscription,
    );
    const appearance = (event: Event) => {
      const target = event.target instanceof win.Element ? event.target : undefined;
      if (target?.closest('style[data-native-ui-snapshot], [data-native-ui-projection-node]') || (target && options.ignoreTarget?.(target)))
        return;
      if (target?.hasAttribute('data-native-ui-snapshot') && (event as TransitionEvent).pseudoElement) return;
      changed();
    };
    for (const name of ['load', 'transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'])
      doc.addEventListener(name, appearance, { ...subscription, capture: name === 'load' });
  };
  const followMotion = (moving: ReadonlyMap<HTMLElement, unknown>, target: (source: HTMLElement) => HTMLElement = (source) => source) => {
    if (motionFrame || stopped || !moving.size || !doc?.defaultView) return;
    // Ancestor transforms already carry the image. Only the host's own motion needs rebasing.
    const surfaces = values().filter(
      (surface) => (surface.token || surface.restoring) && surface.owners.some((owner) => moving.has(target(owner))),
    );
    if (!surfaces.length) return;
    motionFrame = doc.defaultView.requestAnimationFrame(() => {
      motionFrame = 0;
      surfaces.forEach((surface) => surface.moved());
      followMotion(moving, target);
    });
  };
  const remove = async (owner: Owner) => {
    const entry = entries.get(owner);
    if (!entry) return;
    entries.delete(owner);
    await retire(entry.surface ? entry.surface.destroy() : entry.ready.catch(() => {}));
  };
  return {
    get: (owner: Owner) => entries.get(owner)?.surface,
    keys: () => entries.keys(),
    values,
    changed,
    invalidate,
    followMotion,
    end: () => values().forEach((surface) => surface.end()),
    consider: (...args: Parameters<WebProjectionSurface['consider']>) => values().forEach((surface) => surface.consider(...args)),
    updated: (...args: Parameters<WebProjectionSurface['updated']>) => values().forEach((surface) => surface.updated(...args)),
    get restoring() {
      return values().some((surface) => surface.restoring);
    },
    get handoffPending() {
      return values().some((surface) => surface.handoffPending);
    },
    ensure(owner: Owner, create: () => Promise<Surface>): Promise<Surface | undefined> {
      if (stopped || !owner.isConnected) return Promise.resolve(undefined);
      observe(owner);
      const existing = entries.get(owner);
      if (existing) return existing.ready;
      const entry: Entry = {
        ready: Promise.resolve()
          .then(create)
          .then(async (surface) => {
            if (stopped || entries.get(owner) !== entry || !owner.isConnected) {
              if (entries.get(owner) === entry) entries.delete(owner);
              await retire(surface.destroy());
              return undefined;
            }
            entry.surface = surface;
            return surface;
          })
          .catch((error) => {
            if (entries.get(owner) === entry) entries.delete(owner);
            throw error;
          }),
      };
      entries.set(owner, entry);
      return entry.ready;
    },
    delete: remove,
    async destroy() {
      stopped = true;
      listeners?.abort();
      if (motionFrame) doc?.defaultView?.cancelAnimationFrame(motionFrame);
      await Promise.all([...retiring, ...[...entries.keys()].map(remove)]);
    },
  };
};
