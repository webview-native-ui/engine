import type { CoveredSnapshots } from '../shared/covered-snapshot.js';

export { usesOverlayBackdrop as usesCoveredBackground } from '../../index.js';
import { usesOverlayBackdrop as usesCoveredBackground } from '../../index.js';

/** The prepared image is optional; Ionic presentation never waits for it. */
export const coverOverlayBackground = (element: HTMLElement, snapshots: CoveredSnapshots) => {
  if (usesCoveredBackground(element))
    snapshots.begin(element.matches('ion-modal') ? (element as HTMLIonModalElement).presentingElement : undefined);
  else snapshots.retireRestoration();
};
