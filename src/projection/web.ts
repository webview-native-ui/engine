import { projectionURL } from '../native/resource-url.js';
import type {
  WebProjectionSource,
  ScopedWebProjectionSource as Candidate,
  PreparedWebProjection as CoveredSnapshot,
  Frame,
  WebProjectionTransport,
} from '../types.js';
import type { WebProjectionScope } from './scope.js';
import { bounded, boundedListener } from '../native/bridge.js';
import { bindProjectionEvents, type ProjectionEvents, type ProjectionDestination } from './events.js';
import { snapshotStyles, snapshotShadowStyles } from './styles.js';

export interface WebProjectionOptions {
  /** Existing plugin notifications, scoped to this presentation surface. */
  events?: ProjectionEvents;
  /** Debounce before preparing replacement pixels, in milliseconds. Defaults to 50; never delays handoff. */
  captureDelayMs?: number;
  /** Preserve an idle underlay while native disarms a possible early drag cover. */
  retainPreparedUntilRelease?: boolean;
  wake(): void;
  blocked(): boolean;
  revision?(): number;
  /** Content version for native pixel reuse; layout revision remains independent. */
  captureRevision?(): number;
  /** Select this surface's sources, e.g. the underlying page or the active overlay. */
  eligible?(source: Candidate): boolean;
  /** Reject a cached image when its owning surface has changed. */
  current?(sources: HTMLElement[]): boolean;
  /** Temporary movement handoff: rebase return pixels to the current display DOM. */
  transient?: boolean;
  /** Opaque full-view pixels map to the host border box and may paint beneath native. */
  opaqueUnderlay?: boolean;
}

interface Prepared {
  data: CoveredSnapshot;
  images: HTMLImageElement[];
  sources: HTMLElement[];
  targets: HTMLElement[];
  scopes: WebProjectionScope[];
  parents: (Node | null)[];
  frames: Frame[];
  viewport: string;
  revision: number;
  layout: string;
}

const layout = ({ control: c }: Candidate, positionIndependent = false) => [
  c.id,
  c.kind,
  c.placement,
  positionIndependent ? 0 : c.x,
  positionIndependent ? 0 : c.y,
  c.width,
  c.height,
  c.dark,
  c.rtl,
];

/** Images are prepared after accepted native updates, never on the overlay's critical path. */
const createProjectionEngine = async (scope: WebProjectionScope, transport: WebProjectionTransport, callbacks: WebProjectionOptions) => {
  const captureDelayMs = callbacks.captureDelayMs ?? 50;
  if (!Number.isFinite(captureDelayMs) || captureDelayMs < 0 || captureDelayMs > 2147483647)
    throw new RangeError('captureDelayMs must be a finite, nonnegative timer interval');
  let destination: ProjectionDestination = 'native';
  const doc = scope.element.ownerDocument;
  const win = doc.defaultView!;
  // Native tokens are local to a transport; never use them as global CSS identities.
  const imageIdentity = Array.from(win.crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('-');
  const validSource = (source: HTMLElement) => source.isConnected && source.ownerDocument === doc;
  const validTarget = (target: HTMLElement | undefined): target is HTMLElement => !!target?.isConnected && target.ownerDocument === doc;
  // Keep current, preparing and pending-release images leased; reuse idle DOM slots.
  const imagePool = new Map<HTMLElement, HTMLImageElement[]>();
  const leasedImages = new Set<HTMLImageElement>();
  const retireImage = (image: HTMLImageElement) => {
    leasedImages.delete(image);
    image.style.setProperty('display', 'none', 'important');
    image.removeAttribute('data-native-ui-projection-image');
    image.removeAttribute('src');
    pruneIdleImages();
  };
  const call = transport.send.bind(transport);
  const imageMarker = 'data-native-ui-snapshot';
  const sourcesChangedEvent = `${scope.namespace}:sources-change`;
  const owners = new Set<HTMLElement>(),
    visibleOwners = new Set<HTMLElement>(),
    preparedOwners = new Set<HTMLElement>();
  const scopeIDs = new WeakMap<WebProjectionScope, number>();
  let scopeSerial = 0;
  const signature = (candidates: Candidate[]) =>
    JSON.stringify(
      candidates.map((candidate) => {
        if (!scopeIDs.has(candidate.scope)) scopeIDs.set(candidate.scope, ++scopeSerial);
        const origin = callbacks.transient && !callbacks.opaqueUnderlay ? candidate.scope.element.getBoundingClientRect() : undefined;
        const relative = origin
          ? { ...candidate, control: { ...candidate.control, x: candidate.control.x - origin.x, y: candidate.control.y - origin.y } }
          : candidate;
        return [scopeIDs.get(candidate.scope), layout(relative, !!callbacks.opaqueUnderlay)];
      }),
    );
  const sheets = new Map<Document | ShadowRoot, HTMLStyleElement>();
  const rootFor = (element: HTMLElement) => {
    const root = element.getRootNode();
    return root.nodeType === 11 && 'host' in root ? (root as ShadowRoot) : doc;
  };
  const sheetFor = (root: Document | ShadowRoot) => {
    if (sheets.has(root)) return;
    const style = doc.createElement('style');
    style.setAttribute('data-native-ui-snapshot-base', '');
    style.textContent = snapshotStyles + (root.nodeType === 11 ? snapshotShadowStyles : '');
    (root.nodeType === 11 ? root : (root as Document).head).append(style);
    sheets.set(root, style);
  };
  // Each shadow tree is a separate style scope. Keep these rules alongside the
  // prepared image; only the marker changes during the handoff.
  const finishVisibilityTransitions = (target: HTMLElement) => {
    // A visibility transition can keep the old content painted over the image.
    // Do not stop layout, transform or opacity transitions owned by the renderer.
    const animations = [
      ...target.getAnimations({ subtree: true }),
      ...[...(shadowHosts.get(target) ?? [])].flatMap((host) => host.shadowRoot?.getAnimations() ?? []),
    ];
    for (const animation of animations)
      if ('transitionProperty' in animation && animation.transitionProperty === 'visibility') animation.cancel();
  };
  const shadowHosts = new Map<HTMLElement, Set<HTMLElement>>();
  const syncShadowContent = (target: HTMLElement) => {
    const hosts = shadowHosts.get(target) ?? new Set<HTMLElement>();
    shadowHosts.set(target, hosts);
    const hidden = target.hasAttribute('data-native-ui-snapshot-source') || target.hasAttribute('data-native-ui-snapshot-prepared');
    const visit = (element: HTMLElement) => {
      if (element.hasAttribute('data-native-ui-projection-node')) return;
      if (element.shadowRoot) {
        hosts.add(element);
        sheetFor(element.shadowRoot);
        for (const child of element.shadowRoot.children) visit(child as HTMLElement);
      }
      for (const child of element.children) visit(child as HTMLElement);
    };
    visit(target);
    for (const host of hosts) host.toggleAttribute('data-native-ui-snapshot-content', hidden);
    finishVisibilityTransitions(target);
  };
  const viewport = () => `${win.innerWidth}:${win.innerHeight}:${win.devicePixelRatio}`;
  let handoffPending = false;
  let presented = false;
  let paintFrame = 0;
  let presentation = 0;
  let cached: Prepared | undefined;
  let retiring: object | undefined;
  let active: Prepared | undefined;
  let touching = false;
  let ending = false;
  let restoreTimeout = 0;
  let restoreRevision = 0;
  let generation = 0;
  let timer = 0;
  let visualRevision = 0;
  let preparedVisualRevision = -1;
  let stopped = false;
  let flight = false;
  let latest: { revision: number; candidates: Candidate[] } | undefined;
  const pruneIdleImages = () => {
    const targets = new Set(latest?.candidates.map((candidate) => candidate.scope.element));
    for (const [target, pool] of imagePool) {
      const reusable = !stopped && target.isConnected && targets.has(target);
      if (reusable && (active || ending || handoffPending)) continue;
      const limit = reusable ? 2 * Math.max(1, cached?.scopes.filter((scope) => scope.element === target).length ?? 0) : 0;
      let spare = Math.max(0, limit - pool.filter((image) => leasedImages.has(image)).length);
      const retained = pool.filter((image) => {
        if (leasedImages.has(image) || spare-- > 0) return true;
        image.remove();
        return false;
      });
      if (retained.length) imagePool.set(target, retained);
      else imagePool.delete(target);
    }
    const liveRoots = new Set<Node>([
      ...(latest?.candidates.map((candidate) => candidate.scope.element.getRootNode()) ?? []),
      ...(active?.scopes.map((scope) => scope.element.getRootNode()) ?? []),
      ...(cached?.scopes.map((scope) => scope.element.getRootNode()) ?? []),
      ...[...leasedImages].map((image) => image.getRootNode()),
      ...[...shadowHosts.values()].flatMap((hosts) => [...hosts].map((host) => host.shadowRoot!)),
    ]);
    for (const [root, pair] of sheets)
      if (root.nodeType === 11 && !liveRoots.has(root)) {
        pair.remove();
        sheets.delete(root);
      }
  };
  const pendingCleanup = new Set<() => void>();
  const cleanup = (action: 'release' | 'restored', token: string, afterPaint: boolean) => {
    const run = () => {
      if (!pendingCleanup.delete(run)) return;
      void call({ action, token }).catch(() => {});
      if (action === 'restored') pruneIdleImages();
    };
    pendingCleanup.add(run);
    if (afterPaint && !stopped) win.requestAnimationFrame(() => win.requestAnimationFrame(run));
    else run();
  };
  const preparedSources = new Set<HTMLElement>();
  const clearPrepared = () => {
    preparedSources.forEach((source) => preparedOwners.delete(source));
    preparedSources.clear();
  };
  const dispose = (item: Prepared | undefined, afterPaint = false) => {
    if (!item || item === cached || item === active) return;
    item.images.forEach((image) => {
      retireImage(image);
    });
    cleanup('release', item.data.token, afterPaint);
  };
  const select = (candidates: Candidate[]) =>
    candidates.filter((candidate) => {
      if (!validTarget(candidate.scope.element) || ![candidate.element, ...(candidate.sources ?? [])].every(validSource)) return false;
      // Native scroll bindings retain offscreen controls. They have no visible
      // pixels to capture and must not prevent the other controls being prepared.
      if (candidate.control.scroll) {
        const rect = candidate.element.getBoundingClientRect();
        const clip = candidate.control.scroll.clip;
        if (rect.right <= clip.x || rect.bottom <= clip.y || rect.left >= clip.x + clip.width || rect.top >= clip.y + clip.height)
          return false;
      }
      return callbacks.eligible?.(candidate) ?? true;
    });
  const prepare = async () => {
    timer = 0;
    if (
      stopped ||
      destination !== 'native' ||
      flight ||
      touching ||
      active ||
      callbacks.blocked() ||
      !latest ||
      (cached?.revision === latest.revision && preparedVisualRevision === visualRevision)
    )
      return;
    const { revision, candidates } = latest;
    const stamp = generation;
    const visual = visualRevision;
    const size = viewport();
    const selected = select(candidates);
    if (!selected.length) return;
    flight = true;
    let result: Partial<CoveredSnapshot> | undefined;
    let adopted = false;
    const images: HTMLImageElement[] = [];
    try {
      let expired = false;
      const capture = call({
        action: 'prepare',
        revision: callbacks.captureRevision?.() ?? revision,
        viewportWidth: win.innerWidth,
        ids: selected.map((item) => item.control.id),
      });
      void capture
        .then((late) => {
          if (expired && late.token) void call({ action: 'release', token: late.token }).catch(() => {});
        })
        .catch(() => {});
      try {
        result = await bounded(capture);
      } finally {
        expired = true;
      }
      if (!result.token || !result.parts?.length) return;
      const ids = new Set(selected.map((candidate) => candidate.control.id));
      if (
        result.parts.some(
          (part) =>
            (!part.url.startsWith('file:') &&
              !/^\/__native_ui_engine__\/nativeUI[a-fA-F0-9]+\/[a-fA-F0-9-]+-[0-9]+\.png$/.test(part.url)) ||
            !part.ids.length ||
            part.ids.some((id) => !ids.has(id)) ||
            ![part.x, part.y, part.width, part.height].every(Number.isFinite) ||
            part.width <= 0 ||
            part.height <= 0,
        )
      )
        return;
      if (new Set(result.parts.flatMap((part) => part.ids)).size !== ids.size) return;
      // One crop may cover a button group, but must have one fixed fallback destination.
      if (
        result.parts.some(
          (part) => new Set(part.ids.map((id) => selected.find((candidate) => candidate.control.id === id)!.scope)).size !== 1,
        )
      )
        return;
      const partSources = result.parts.map((part) => selected.find((candidate) => part.ids.includes(candidate.control.id))!);
      await bounded(
        Promise.all(
          result.parts.map(async (part, index) => {
            const target = partSources[index].scope.element;
            let pool = imagePool.get(target);
            if (!pool) {
              pool = [];
              imagePool.set(target, pool);
            }
            let image = pool.find((item) => !leasedImages.has(item));
            if (!image) {
              image = doc.createElement('img');
              image.setAttribute('data-native-ui-projection-node', '');
              pool.push(image);
            }
            leasedImages.add(image);
            images.push(image);
            image.src = projectionURL(part.url);
            await image.decode();
            return image;
          }),
        ),
      );
      if (
        stopped ||
        destination !== 'native' ||
        touching ||
        active ||
        callbacks.blocked() ||
        generation !== stamp ||
        viewport() !== size ||
        latest?.revision !== revision ||
        selected.some(
          (candidate) => !validTarget(candidate.scope.element) || ![candidate.element, ...(candidate.sources ?? [])].every(validSource),
        )
      )
        return;
      const previous = cached;
      const prepared: Prepared = {
        data: result as CoveredSnapshot,
        images,
        sources: Array.from(new Set(selected.flatMap((item) => [item.element, ...(item.sources ?? [])]))),
        targets: partSources.map((source) => source.element),
        scopes: partSources.map((source) => source.scope),
        parents: partSources.map((source) => source.scope.element.parentNode),
        frames: [],
        viewport: size,
        revision,
        layout: signature(selected),
      };
      try {
        if (!render(prepared)) throw new Error('Projection destination is unavailable');
      } catch (error) {
        // Do not publish a token whose DOM could not be installed. Restore the
        // last completed presentation before retiring the failed preparation.
        detach();
        try {
          render();
          cached?.sources.forEach((source) => {
            preparedOwners.add(source);
            preparedSources.add(source);
          });
        } catch {
          abandon();
        }
        throw error;
      }
      cached = prepared;
      clearPrepared();
      cached.sources.forEach((source) => {
        preparedOwners.add(source);
        preparedSources.add(source);
      });
      if (callbacks.opaqueUnderlay) void call({ action: 'prepared', token: result.token }).catch(() => {});
      win.dispatchEvent(new Event(sourcesChangedEvent));
      preparedVisualRevision = visual;
      adopted = true;
      dispose(previous);
    } catch {
      // Preparing a visual is optional. Preserve the previous image or the Web fallback.
    } finally {
      if (!adopted)
        images.forEach((image) => {
          retireImage(image);
        });
      if (result?.token && !adopted) void call({ action: 'release', token: result.token }).catch(() => {});
      flight = false;
      if (latest && (latest.revision !== revision || visualRevision !== visual)) schedule();
    }
  };
  // Coalesce changes outside the presentation path. Completed images remain
  // available while their replacement is being rendered and decoded.
  const schedule = () => {
    win.clearTimeout(timer);
    if (!stopped && destination === 'native' && !active && !touching && !callbacks.blocked())
      timer = win.setTimeout(() => void prepare(), captureDelayMs);
  };
  let consideredLayout: string | undefined;
  const consider = (revision: number, candidates: Candidate[]) => {
    if (
      candidates.some(
        (candidate) =>
          candidate.scope.element.ownerDocument !== doc ||
          [candidate.element, ...(candidate.sources ?? [])].some((element) => element.ownerDocument !== doc),
      )
    )
      throw new TypeError('All projection sources and fallback scopes must share one Document');
    // Overlay retirement is not a new source layout. Preserve the pre-overlay
    // image until the presentation path has chosen whether to use it.
    if (callbacks.blocked()) return;
    if (!active && cached && cached.layout !== signature(select(candidates))) invalidate();
    const nextLayout = signature(candidates);
    if (consideredLayout !== nextLayout) {
      consideredLayout = nextLayout;
      visualRevision++;
      generation++;
    }
    if (latest?.revision !== revision) generation++;
    latest = { revision, candidates };
    pruneIdleImages();
    if (cached?.revision !== revision || preparedVisualRevision !== visualRevision) schedule();
  };
  const changed = (scrollOwner?: EventTarget) => {
    // A pre-interaction state image is reusable; an image from another scroll
    // position/clip is not. Invalidate only the surface containing that owner.
    if (
      !active &&
      cached &&
      scrollOwner &&
      latest?.candidates.some((candidate) => candidate.scrollElement === scrollOwner && cached!.sources.includes(candidate.element))
    )
      invalidate();
    if (active) {
      updateOffsets();
    }
    visualRevision++;
    generation++;
    schedule();
  };
  const listener = await boundedListener(
    transport.listen(({ active: pressed }) => {
      touching = pressed;
      generation++;
      win.clearTimeout(timer);
      // The completed cache itself is the pre-interaction image. No separate
      // pin can outlive the interaction and override a newer completed image.
      if (!pressed) schedule();
    }),
  );
  const preparedTargets = new Set<HTMLElement>();
  const clearTarget = (target: HTMLElement) => {
    shadowHosts.get(target)?.forEach((host) => host.removeAttribute('data-native-ui-snapshot-content'));
    if (preparedTargets.delete(target)) target.removeAttribute('data-native-ui-snapshot-prepared');
    target.removeAttribute('data-native-ui-snapshot-visible');
    target.removeAttribute(imageMarker);
    target.removeAttribute('data-native-ui-snapshot-positioned');
    target.removeAttribute('data-native-ui-snapshot-source');
    finishVisibilityTransitions(target);
    shadowHosts.delete(target);
  };
  const detach = () => {
    presentation++;
    win.cancelAnimationFrame(paintFrame);
    for (const element of offsets.keys()) element.style.setProperty('opacity', '0', 'important');
    offsets.clear();
    paintFrame = 0;
    handoffPending = false;
    presented = false;
    clearPrepared();
    active?.sources.forEach((source) => {
      owners.delete(source);
      visibleOwners.delete(source);
    });
    rendered.forEach(clearTarget);
    rendered.clear();
    sheets.forEach((style, root) => {
      if (stopped || (root.nodeType === 11 && !(root as ShadowRoot).host.isConnected)) {
        style.remove();
        sheets.delete(root);
      }
    });
  };
  const abandon = (expected = active, afterPaint = ending) => {
    if (active !== expected) return;
    const previous = new Set([active, cached]);
    detach();
    active = undefined;
    cached = undefined;
    ending = false;
    win.clearTimeout(restoreTimeout);
    previous.forEach((item) => dispose(item, afterPaint));
    callbacks.wake();
  };
  const finishRestoration = () => {
    if (!active) return;
    // A moved return invalidates the cached coordinates, but keeps the active
    // visual until Native has taken ownership at its destination.
    if (cached !== active) {
      abandon();
      return;
    }
    const image = active;
    presentation++;
    win.cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    handoffPending = presented = false;
    image.sources.forEach((source) => {
      owners.delete(source);
      visibleOwners.delete(source);
    });
    rendered.forEach((target) => target.removeAttribute('data-native-ui-snapshot-source'));
    showImages(image, !!callbacks.opaqueUnderlay);
    active = undefined;
    ending = false;
    win.clearTimeout(restoreTimeout);
    // Retire only the temporary return copy. Keep the pre-interaction image
    // available until a replacement finishes, including rapid overlay reopening.
    // Native's update acknowledgement precedes WebKit's paint. Keep its return
    // copy over live glass until the removed Web image has crossed a paint boundary.
    // Flush this callback before another cover can reuse the same token.
    cleanup('restored', image.data.token, true);
    image.sources.forEach((source) => {
      preparedOwners.add(source);
      preparedSources.add(source);
    });
    callbacks.wake();
  };
  const retireRestoration = () => {
    if (ending) finishRestoration();
    pendingCleanup.forEach((run) => run());
  };
  const targetsFor = (image: Prepared) => image.scopes.map((scope) => (validTarget(scope.element) ? scope.element : undefined));
  const rendered = new Set<HTMLElement>();
  const showImages = (image: Prepared, visible: boolean) => {
    for (const target of rendered) {
      target.toggleAttribute('data-native-ui-snapshot-visible', visible);
      syncShadowContent(target);
    }
    image.images.forEach((element) => element.style.setProperty('opacity', visible ? '1' : '0', 'important'));
  };
  const preparedKeys = new Map<HTMLElement, string>();
  const offsets = new Map<HTMLImageElement, { target: HTMLElement; frame: Frame; scale?: { x: number; y: number } }>();
  const updateOffsets = () => {
    const writes: { element: HTMLImageElement; left: number; top: number; width: number; height: number }[] = [];
    // Read all geometry before writing positions; never reset a painted image to zero to measure it.
    for (const [element, placement] of offsets) {
      const { target, frame } = placement;
      if (!target.isConnected) {
        element.remove();
        continue;
      }
      const parent = target.shadowRoot ?? target;
      if (element.parentNode !== parent) parent.insertBefore(element, null);
      const box = target.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const width = parseFloat(element.style.width) || frame.width;
      const height = parseFloat(element.style.height) || frame.height;
      const sx = rect.width / width || 1,
        sy = rect.height / height || 1;
      const initial = placement.scale ?? (placement.scale = { x: sx, y: sy });
      writes.push({
        element,
        left: (parseFloat(element.style.left) || 0) + (box.x + (frame.x * sx) / initial.x - rect.x) / sx,
        top: (parseFloat(element.style.top) || 0) + (box.y + (frame.y * sy) / initial.y - rect.y) / sy,
        width: frame.width / initial.x,
        height: frame.height / initial.y,
      });
    }
    for (const { element, ...values } of writes)
      for (const [property, value] of Object.entries(values)) {
        const next = `${value}px`;
        if (element.style.getPropertyValue(property) !== next) element.style.setProperty(property, next, 'important');
      }
  };
  const render = (image = active ?? cached) => {
    if (!image || ending) return false;
    if (!image.sources.every(validSource) || targetsFor(image).some((target) => !target)) {
      invalidate();
      return false;
    }
    const targets = targetsFor(image);
    if (active) {
      if (targets.some((target) => !target?.isConnected || !sheets.has(rootFor(target)))) {
        abandon(active, false);
        return false;
      }
      const next = new Set<HTMLElement>();
      for (const [index, source] of image.targets.entries()) {
        const key = preparedKeys.get(source);
        const target = targets[index];
        if (!key || !target?.isConnected) continue;
        target.setAttribute(imageMarker, key);
        target.setAttribute('data-native-ui-snapshot-source', '');
        next.add(target);
      }
      for (const target of rendered) if (!next.has(target)) clearTarget(target);
      rendered.clear();
      next.forEach((target) => rendered.add(target));
      showImages(image, presented);
      return true;
    }
    imagePool.forEach((pool) =>
      pool.forEach((element) => {
        if (!image.images.includes(element)) {
          element.style.setProperty('display', 'none', 'important');
          element.removeAttribute('data-native-ui-projection-image');
        }
      }),
    );
    preparedKeys.clear();
    offsets.clear();
    rendered.forEach(clearTarget);
    rendered.clear();
    for (const target of new Set(targets)) {
      if (!target) continue;
      rendered.add(target);
      sheetFor(rootFor(target));
      const indices = targets.flatMap((owner, index) => (owner === target ? [index] : []));
      const key = `${imageIdentity}-${indices[0]}`;
      target.setAttribute(imageMarker, key);
      if (target !== image.targets[indices[0]]) {
        target.setAttribute('data-native-ui-snapshot-prepared', '');
        preparedTargets.add(target);
      }
      target.toggleAttribute('data-native-ui-snapshot-visible', !!callbacks.opaqueUnderlay);
      syncShadowContent(target);
      const box = target.getBoundingClientRect();
      target.toggleAttribute('data-native-ui-snapshot-positioned', win.getComputedStyle(target).position === 'static');
      const parent = target.shadowRoot ?? target;
      for (const index of [...indices].reverse()) {
        const element = image.images[index];
        const part = image.data.parts[index];
        const frame = image.frames[index] ?? {
          x: callbacks.opaqueUnderlay ? 0 : part.x - box.x,
          y: callbacks.opaqueUnderlay ? 0 : part.y - box.y,
          width: part.width,
          height: part.height,
        };
        image.frames[index] = frame;
        preparedKeys.set(image.targets[index], key);
        element.inert = true;
        element.setAttribute('aria-hidden', 'true');
        element.setAttribute('data-native-ui-projection-image', key);
        element.style.cssText =
          'all:initial!important;position:absolute!important;display:block!important;visibility:visible!important;pointer-events:none!important;image-rendering:pixelated!important;will-change:opacity!important;opacity:0!important;';
        element.style.setProperty('width', `${frame.width}px`, 'important');
        element.style.setProperty('height', `${frame.height}px`, 'important');
        element.style.setProperty('left', '0px', 'important');
        element.style.setProperty('top', '0px', 'important');
        element.style.setProperty('opacity', callbacks.opaqueUnderlay ? '1' : '0', 'important');
        if (element.parentNode !== parent) parent.insertBefore(element, null);
        offsets.set(element, { target, frame });
      }
    }
    image.parents = image.scopes.map((scope) => scope.element.parentNode);
    updateOffsets();
    return true;
  };

  const currentParts = (image: Prepared) =>
    image.images.map((element, index) => {
      const rect = element.getBoundingClientRect();
      return { ...image.data.parts[index], x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

  const begin = () => {
    retireRestoration();
    if (stopped || destination === 'none' || active) return;
    const image = cached;
    if (
      !image ||
      image.viewport !== viewport() ||
      !image.sources.every(validSource) ||
      (callbacks.current && !callbacks.current(image.targets)) ||
      image.targets.some((source) => !preparedKeys.has(source)) ||
      targetsFor(image).some((target) => !target?.isConnected) ||
      [...rendered].some((target) => !target.isConnected)
    )
      return;
    // Reparenting is renderer-owned. Only that case needs a fresh coordinate conversion;
    // ordinary presentation keeps the prepared layout off the critical path.
    if (image.scopes.some((scope, index) => scope.element.parentNode !== image.parents[index])) render();
    updateOffsets();
    // A cached image may span multiple presentations; bridge replies may not.
    const currentPresentation = ++presentation;
    const isCurrent = () => presentation === currentPresentation;
    handoffPending = true;
    presented = !!callbacks.opaqueUnderlay;
    active = image;
    // Reuse decoded pixels; no capture, bridge acknowledgement or animation wait.
    generation++;
    win.clearTimeout(timer);
    image.sources.forEach((source) => {
      owners.add(source);
    });
    rendered.forEach((target) => target.setAttribute('data-native-ui-snapshot-source', ''));
    showImages(image, presented);
    // Reconciliation may continue after one frame even if the optional bridge reply
    // is delayed. The ordered native transport processes cover before that update.
    paintFrame = win.requestAnimationFrame(() => {
      paintFrame = 0;
      if (!isCurrent()) return;
      handoffPending = false;
      callbacks.wake();
    });
    void bounded(
      call({
        action: 'cover',
        token: image.data.token,
        ...(callbacks.transient ? { transient: true, viewportWidth: win.innerWidth, parts: currentParts(image) } : {}),
      }),
    )
      .then((result) => {
        if (!isCurrent()) return;
        handoffPending = false;
        if (result?.shown !== true) {
          abandon(image, false);
          return;
        }
        // Live translucent Native must be hidden before its composited Web image
        // becomes visible. Native's prepared entry copy spans this bridge interval.
        if (!ending) {
          presented = true;
          image.sources.forEach((source) => visibleOwners.add(source));
          render();
          updateOffsets();
        }
        win.cancelAnimationFrame(paintFrame);
        paintFrame = win.requestAnimationFrame(() => {
          paintFrame = 0;
          if (!isCurrent()) return;
          void call({ action: 'painted', token: image.data.token })
            .then((result) => {
              if (isCurrent() && result?.shown === false) abandon(image, false);
            })
            .catch(() => {
              if (isCurrent()) abandon(image, false);
            });
        });
        callbacks.wake();
      })
      .catch(() => {
        if (isCurrent()) abandon(image, false);
      });
  };
  const end = () => {
    if (!active || stopped || ending) return;
    // A return belongs to the captured surface, never to the modal exposed beneath it.
    if (
      !active.sources.every(validSource) ||
      targetsFor(active).some((target) => !target) ||
      (callbacks.current && !callbacks.current(active.targets))
    ) {
      abandon(active, false);
      return;
    }
    if (callbacks.blocked()) return;
    updateOffsets();
    if (callbacks.transient) {
      const image = active;
      const targets = targetsFor(image);
      if (targets.some((target) => !target?.isConnected)) {
        abandon(image, false);
        return;
      }
      const parts = currentParts(image);
      // Translation changes placement, not pixels. Keep the pre-interaction
      // image until its replacement is ready; resizing still invalidates it.
      if (
        callbacks.opaqueUnderlay ||
        parts.every((part, index) => part.width === image.data.parts[index].width && part.height === image.data.parts[index].height)
      )
        image.data = { ...image.data, parts };
      else cached = undefined;
      // Both requests use the same ordered bridge. Reprojection need not await this optional copy.
      void call({ action: 'restore', token: image.data.token, viewportWidth: win.innerWidth, parts }).catch(() => {});
    }
    restoreRevision = callbacks.revision?.() ?? latest?.revision ?? 0;
    ending = true;
    active.sources.forEach((source) => owners.delete(source));
    restoreTimeout = win.setTimeout(() => {
      if (ending) abandon(active, false);
    }, 250);
    callbacks.wake();
  };
  const updated = (token: string | undefined, restoredIDs?: string[], revision?: number) => {
    if (!ending || !active || revision === undefined || revision <= restoreRevision) return;
    if (!callbacks.transient && token) return;
    if (!active.data.parts.every((part) => part.ids.every((id) => restoredIDs?.includes(id)))) return;
    // Retire the Web image at the native restore acknowledgement, not after
    // another complete reconciliation/paint cycle over live glass.
    finishRestoration();
    schedule();
  };
  const invalidate = (nativeHidden = false) => {
    pendingCleanup.forEach((run) => run());
    generation++;
    win.clearTimeout(timer);
    const previous = cached;
    cached = undefined;
    if (nativeHidden || stopped) retiring = undefined;
    if (callbacks.retainPreparedUntilRelease && !active && !nativeHidden && !stopped) {
      if (previous) {
        const pending = {};
        retiring = pending;
        void bounded(call({ action: 'release', token: previous.data.token }))
          .catch(() => {})
          .finally(() => {
            previous.images.forEach((image) => {
              retireImage(image);
            });
            if (retiring !== pending) return;
            retiring = undefined;
            if (cached || active) return;
            // Another session can already own the same host; retire only our own DOM markers.
            for (const target of rendered) {
              if (target.getAttribute(imageMarker) !== preparedKeys.get(target)) {
                rendered.delete(target);
                preparedTargets.delete(target);
              }
            }
            detach();
            preparedKeys.clear();
            win.dispatchEvent(new Event(sourcesChangedEvent));
          });
      }
      if (retiring) return;
    }
    dispose(previous);
    if (active) abandon(active, false);
    else {
      detach();
      preparedKeys.clear();
      win.dispatchEvent(new Event(sourcesChangedEvent));
    }
  };
  let eventListener: Awaited<ReturnType<typeof bindProjectionEvents>> | undefined;
  try {
    if (callbacks.events)
      eventListener = await bindProjectionEvents(callbacks.events, (next, updated) => {
        if (stopped) return;
        if (next) destination = next;
        // Native hide has already happened. Retire images and invalidate pending captures,
        // without calling the plugin's public hide method or disturbing its fallback DOM.
        if (destination === 'none') {
          invalidate();
          return;
        }
        if (next === 'web') begin();
        if (next === 'native') {
          end();
          schedule();
        }
        if (updated) changed();
      });
  } catch (error) {
    stopped = true;
    invalidate();
    await bounded(Promise.resolve(listener.remove())).catch(() => {});
    throw error;
  }
  return {
    get owners(): readonly HTMLElement[] {
      return [...owners];
    },
    get visibleOwners(): readonly HTMLElement[] {
      return [...visibleOwners];
    },
    get preparedOwners(): readonly HTMLElement[] {
      return [...preparedOwners];
    },
    consider,
    changed,
    moved: updateOffsets,
    get token() {
      return ending ? undefined : active?.data.token;
    },
    begin,
    get restoring() {
      return ending;
    },
    get handoffPending() {
      return handoffPending;
    },
    retireRestoration,
    end,
    updated,
    invalidate,
    async destroy() {
      stopped = true;
      invalidate();
      imagePool.forEach((pool) => pool.forEach((image) => image.remove()));
      imagePool.clear();
      await Promise.allSettled([
        bounded(Promise.resolve().then(() => listener?.remove())),
        bounded(Promise.resolve().then(() => eventListener?.remove())),
      ]);
    },
  };
};
type Engine = Awaited<ReturnType<typeof createProjectionEngine>>;
export type WebProjection = Omit<Engine, 'consider'> & { consider(revision: number, sources: WebProjectionSource[]): void };
export type WebProjectionBatch = Omit<Engine, 'consider'> & { consider(revision: number, sources: Candidate[]): void };

/** One existing fallback DOM, with no separate document or rendering destination. */
export const createWebProjection = async (
  scope: WebProjectionScope,
  transport: WebProjectionTransport,
  options: WebProjectionOptions,
): Promise<WebProjection> => {
  const engine = await createProjectionEngine(scope, transport, options);
  const consider = engine.consider;
  return Object.assign(engine, {
    consider: (revision: number, sources: WebProjectionSource[]) =>
      consider(
        revision,
        sources.map((source) => ({ ...source, scope })),
      ),
  });
};

/** A single Native transaction for multiple fixed fallback DOMs. */
export const createWebProjectionBatch = async (
  transport: WebProjectionTransport,
  options: WebProjectionOptions,
): Promise<WebProjectionBatch> => {
  let engine: Engine | undefined;
  let initializing: Promise<void> | undefined;
  let latest: { revision: number; sources: Candidate[] } | undefined;
  let stopped = false;
  let batchDocument: Document | undefined;
  return {
    get owners() {
      return engine?.owners ?? [];
    },
    get visibleOwners() {
      return engine?.visibleOwners ?? [];
    },
    get preparedOwners() {
      return engine?.preparedOwners ?? [];
    },
    get token() {
      return engine?.token;
    },
    get restoring() {
      return engine?.restoring ?? false;
    },
    get handoffPending() {
      return engine?.handoffPending ?? false;
    },
    consider(revision, sources) {
      if (stopped) return;
      const doc = batchDocument ?? sources[0]?.scope.element.ownerDocument;
      if (
        doc &&
        sources.some(
          (source) =>
            source.scope.element.ownerDocument !== doc ||
            [source.element, ...(source.sources ?? [])].some((element) => element.ownerDocument !== doc),
        )
      )
        throw new TypeError('All projection sources and fallback scopes must share one Document');
      batchDocument = doc;
      latest = { revision, sources };
      if (engine) {
        engine.consider(revision, sources);
        return;
      }
      if (initializing || !sources.length) return;
      initializing = createProjectionEngine(sources[0].scope, transport, options)
        .then(async (created) => {
          if (stopped) {
            await created.destroy();
            return;
          }
          engine = created;
          if (latest) engine.consider(latest.revision, latest.sources);
        })
        .catch(() => {
          initializing = undefined;
          options.wake();
        });
    },
    changed: (owner) => engine?.changed(owner),
    moved: () => engine?.moved(),
    begin: () => engine?.begin(),
    end: () => engine?.end(),
    updated: (token, ids, revision) => engine?.updated(token, ids, revision),
    retireRestoration: () => engine?.retireRestoration(),
    invalidate: (nativeHidden?: boolean) => engine?.invalidate(nativeHidden),
    async destroy() {
      stopped = true;
      await initializing;
      await engine?.destroy();
    },
  };
};
