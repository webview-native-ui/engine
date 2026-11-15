import type { PreparedWebProjection, ScopedWebProjectionSource } from '../types.js';

/** Validate crop metadata and resolve each crop's fallback source before decoding. */
export const sourcesForCapture = (
  parts: PreparedWebProjection['parts'],
  candidates: readonly ScopedWebProjectionSource[],
): ScopedWebProjectionSource[] | undefined => {
  const ids = new Set(candidates.map((candidate) => candidate.control.id));
  if (
    parts.some(
      (part) =>
        (!part.url.startsWith('file:') && !/^\/__native_ui_engine__\/nativeUI[a-fA-F0-9]+\/[a-fA-F0-9-]+-[0-9]+\.png$/.test(part.url)) ||
        !part.ids.length ||
        part.ids.some((id) => !ids.has(id)) ||
        ![part.x, part.y, part.width, part.height].every(Number.isFinite) ||
        part.width <= 0 ||
        part.height <= 0 ||
        (part.anchorBounds !== undefined &&
          (!part.anchorBounds ||
            ![part.anchorBounds.x, part.anchorBounds.y, part.anchorBounds.width, part.anchorBounds.height].every(Number.isFinite) ||
            part.anchorBounds.width <= 0 ||
            part.anchorBounds.height <= 0)),
    )
  )
    return undefined;
  if (new Set(parts.flatMap((part) => part.ids)).size !== ids.size) return undefined;
  // One crop may cover a button group, but must have one fixed fallback destination.
  if (parts.some((part) => new Set(part.ids.map((id) => candidates.find((candidate) => candidate.control.id === id)!.scope)).size !== 1))
    return undefined;
  return parts.map((part) => candidates.find((candidate) => part.ids.includes(candidate.control.id))!);
};
