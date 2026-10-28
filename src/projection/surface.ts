import { createWebProjectionBatch, type WebProjectionOptions } from './web.js';
import { createWebProjectionScope, type WebProjectionScope } from './scope.js';
import type { WebProjectionSource, WebProjectionTransport } from '../types.js';

export interface WebProjectionSurfaceOptions extends WebProjectionOptions {
  namespace: string;
  target(source: WebProjectionSource): HTMLElement | undefined;
  /** Only renderer-owned fallback hosts may move into another overlay layer. */
  canRelocate?(target: HTMLElement): boolean;
}

/** A renderer supplies placement policy; the Engine owns the complete image handoff. */
export const createWebProjectionSurface = async (transport: WebProjectionTransport, options: WebProjectionSurfaceOptions) => {
  const scopes = new WeakMap<HTMLElement, WebProjectionScope>();
  const moved = new Map<HTMLElement, { parent: Node; next: ChildNode | null; layer: HTMLElement }>();
  const restorePlacement = () => {
    for (const [element, saved] of [...moved].reverse()) {
      if (element.parentNode === saved.layer && saved.parent.isConnected)
        saved.parent.insertBefore(element, saved.next?.parentNode === saved.parent ? saved.next : null);
    }
    moved.clear();
  };
  const projection = await createWebProjectionBatch(transport, {
    ...options,
    wake: () => {
      if (!projection.token && !projection.restoring) restorePlacement();
      options.wake();
    },
  });
  let latest: WebProjectionSource[] = [];
  const { consider, begin, updated, invalidate, destroy } = projection;
  return Object.assign(projection, {
    consider(revision: number, sources: WebProjectionSource[]) {
      latest = sources;
      consider(
        revision,
        sources.flatMap((source) => {
          const target = options.target(source);
          if (!target?.isConnected || target.ownerDocument !== source.element.ownerDocument) return [];
          let scope = scopes.get(target);
          if (!scope) {
            scope = createWebProjectionScope(target, options.namespace);
            scopes.set(target, scope);
          }
          return [{ ...source, scope }];
        }),
      );
    },
    begin(layer?: HTMLElement) {
      if (layer && !layer.isConnected) return;
      if (layer && !projection.token) {
        for (const source of latest) {
          if (!projection.preparedOwners.includes(source.element)) continue;
          const target = options.target(source);
          if (
            !target?.isConnected ||
            !target.parentNode ||
            target.ownerDocument !== layer.ownerDocument ||
            layer.contains(target) ||
            target.contains(layer) ||
            !options.canRelocate?.(target)
          )
            continue;
          if (!moved.has(target)) moved.set(target, { parent: target.parentNode, next: target.nextSibling, layer });
          layer.append(target);
        }
      }
      begin();
      if (!projection.token) restorePlacement();
    },
    updated(token: string | undefined, ids?: string[], revision?: number) {
      updated(token, ids, revision);
      if (!projection.restoring && !projection.token) restorePlacement();
    },
    invalidate(nativeHidden?: boolean) {
      invalidate(nativeHidden);
      restorePlacement();
    },
    async destroy() {
      try {
        await destroy();
      } finally {
        restorePlacement();
      }
    },
  });
};
export type WebProjectionSurface = Awaited<ReturnType<typeof createWebProjectionSurface>>;
