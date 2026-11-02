import type { VerticalControlAreaOptions } from '../definitions.js';
import * as button from './ion-button.js';
import * as buttons from './ion-buttons.js';
import * as backButton from './ion-back-button.js';
import * as menuButton from './ion-menu-button.js';
import * as tabBar from './ion-tab-bar.js';
import * as segment from './ion-segment.js';
import * as fab from './ion-fab.js';
import { isVerticalBarsSource, visible, withoutPrehide } from '../shared/dom.js';
import type { Candidate, Identify } from '../shared/candidate.js';

// Static composition only. Each component declares its own tag, discovery and reader.
export const components = [button, buttons, backButton, menuButton, tabBar, segment, fab] as const;
export type NativeUIComponent = (typeof components)[number]['tag'];
export const selector = components
  .map((component) => ('selector' in component ? component.selector : component.tag))
  .filter(Boolean)
  .join(', ');
export const shadowSelector = [
  'ion-icon',
  ...components.flatMap((component) => ('shadowSelector' in component ? [component.shadowSelector] : [])),
].join(', ');
export const motionSelector = [
  '.ion-page',
  'ion-header',
  'ion-footer',
  'ion-toolbar',
  ...components.filter((component) => 'tracksMotion' in component && component.tracksMotion).map((component) => component.tag),
].join(', ');

export const isVerticalBarsCandidate = isVerticalBarsSource;

export const readCandidate = (element: HTMLElement, id: Identify, options: VerticalControlAreaOptions = {}): Candidate | undefined => {
  const verticalBars = isVerticalBarsCandidate(element);
  if (
    (!element.classList.contains('ios') && !verticalBars) ||
    !visible(element, verticalBars) ||
    element.closest('ion-popover') ||
    (element.closest('ion-modal') && !verticalBars)
  )
    return;
  if (element.contains(element.ownerDocument.activeElement)) return;
  // Read icon and control geometry before restoring prehide, which can collapse the toolbar.
  return withoutPrehide(element, () => components.find((component) => component.tag === element.localName)?.read(element, id, options));
};
