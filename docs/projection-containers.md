# Projection container support

Choose the existing DOM element that occupies the native surface's intended location and Web layer. These tables apply to `projectionSelector` and the element passed to `createWebProjectionScope`, for both Capacitor and Cordova.

**⭕️** means the element can contain the Engine's projected image under the stated conditions. **❌** means it is not a supported direct destination; select a suitable surrounding container instead. This is a DOM presentation contract, not a promise that the Engine implements that component's native control, interactions or animations. Native capture eligibility is a separate requirement.

## Shared requirements

- Provide one connected HTML element with a nonzero, unfragmented layout box. Its size, placement and layer belong to the application. For inline hosts, use `display: inline-block` or `block` and give them the intended dimensions.
- `projectionSelector` uses document CSS selectors (ID, class, attribute or descendant). It must match exactly one element and does not enter Shadow DOM. A missing element can be created later; zero or multiple matches keep Native hidden.
- The retained image is inserted in the element's open ShadowRoot, or as a light-DOM child otherwise. Closed shadow content must inherit the host's visibility and expose a slot that can display the image.
- An overlay, collapsed item or inactive page is eligible only while it has a visible layout box. Do not force hidden configuration elements to render just to use them as destinations.
- Host/ancestor clipping, opacity, transforms and filters still affect the image. The image is noninteractive and freezes the captured appearance. See the [projection reference](projection.md#dom-and-native-surface-requirements) for native capture limits and the [renderer guide](renderer-guide.md#low-level-web-projection) for DOM mutation-observer exclusions.

## HTML containers

| Container element                                         | Example                                                              | Support | Notes                                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Block container                                           | `div`, `section`, `nav`, `article`, `header`, `footer`               | ⭕️      | Give the container the intended size and Web layer.                                                                                       |
| Inline container                                          | `span`, `a`, `label`                                                 | ⭕️      | Use `inline-block` or `block`; wrapped inline text is not a single projection surface.                                                    |
| Button                                                    | `button`                                                             | ⭕️      | The original button, listeners and values remain; the image does not receive clicks.                                                      |
| Custom element without Shadow DOM                         | `native-ad`                                                          | ⭕️      | Provide a layout box and allow an image child.                                                                                            |
| Custom element with open Shadow DOM                       | `native-control`                                                     | ⭕️      | The Engine inserts the image directly in the open root and hides fallback content during projection.                                      |
| Custom element with closed Shadow DOM and a suitable slot | `native-control` with a default slot                                 | ⭕️      | The image must be slotted visibly; internal content must inherit host visibility. The Engine cannot enforce rules inside the closed root. |
| Custom element with inaccessible rendering content        | Closed root without a suitable slot                                  | ❌      | Use an outer container; a light-DOM image would not be rendered.                                                                          |
| Native form control                                       | `select`, `input`, `textarea`                                        | ❌      | Direct scopes are rejected. Wrap the control; its value and listeners are preserved.                                                      |
| Replaced media or drawing surface                         | `img`, `canvas`, `video`, `audio`, `iframe`, `embed`, `object`       | ❌      | Direct scopes are rejected. Use a container around the content.                                                                           |
| Void element                                              | `br`, `hr`, `area`, `base`, `link`, `meta`, `source`, `track`, `wbr` | ❌      | Direct scopes are rejected; these cannot contain a projected image.                                                                       |
| Configuration or special child-rendering element          | `option`, `optgroup`, `template`                                     | ❌      | Acceptance by an HTMLElement check does not make an image child renderable. Use a normal container.                                       |
| Non-HTML element                                          | `svg`, SVG `g`, MathML `math`                                        | ❌      | Use an HTML wrapper, not the SVG/MathML node itself.                                                                                      |
| Element without a usable box                              | `display: none`, `display: contents`, zero size                      | ❌      | Choose a visible container with the intended dimensions.                                                                                  |
| Pseudo-element                                            | `::before`, `::after`                                                | ❌      | Not DOM elements and cannot be selected as a scope. Both remain available to the application's CSS.                                       |

## Ionic elements

The following inventory covers every component in the [Ionic API index](https://ionicframework.com/docs/api), with one row per element. It was checked against `@ionic/core` **9.0.9**; `ion-icon` is supplied by Ionicons. The final table separately lists the additional internal component shipped in that version.

Ionic custom elements are not the HTML elements with similar names: `ion-select`, `ion-input`, `ion-textarea` and `ion-img` can be image containers, while HTML `select`, `input`, `textarea` and `img` cannot. Every ⭕️ below still requires the shared layout conditions above and the component's normal Ionic parent/context.

### Buttons and toolbar

| Container element   | Example                         | Support | Notes                                                                                |
| ------------------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `ion-button`        | `ion-button#native-slot`        | ⭕️      | Use the visible host with its intended layout box.                                   |
| `ion-buttons`       | `ion-buttons#native-slot`       | ⭕️      | Use the visible host with its intended layout box.                                   |
| `ion-back-button`   | `ion-back-button#native-slot`   | ⭕️      | Requires a back destination or defaultHref to remain visible.                        |
| `ion-menu-button`   | `ion-menu-button#native-slot`   | ⭕️      | Requires an available menu, or autoHide=false.                                       |
| `ion-toolbar`       | `ion-toolbar#native-slot`       | ⭕️      | Use the visible host with its intended layout box.                                   |
| `ion-header`        | `ion-header#native-slot`        | ⭕️      | Use the visible host with its intended layout box.                                   |
| `ion-footer`        | `ion-footer#native-slot`        | ⭕️      | Use the visible host with its intended layout box.                                   |
| `ion-title`         | `ion-title#native-slot`         | ⭕️      | Use the visible host with its intended layout box.                                   |
| `ion-ripple-effect` | `ion-ripple-effect#native-slot` | ⭕️      | A captured decorative surface, not a button. Prefer the owning button for a control. |

### Forms and selection

| Container element           | Example                                 | Support | Notes                                                                                               |
| --------------------------- | --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `ion-checkbox`              | `ion-checkbox#native-slot`              | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-input`                 | `ion-input#native-slot`                 | ⭕️      | The host is supported; its internal HTML input is not a destination.                                |
| `ion-input-otp`             | `ion-input-otp#native-slot`             | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-input-password-toggle` | `ion-input-password-toggle#native-slot` | ⭕️      | Use inside ion-input; give the host an inline-block box to avoid inline baseline offsets.           |
| `ion-textarea`              | `ion-textarea#native-slot`              | ⭕️      | The host is supported; its internal HTML textarea is not a destination.                             |
| `ion-radio`                 | `ion-radio#native-slot`                 | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-radio-group`           | `ion-radio-group#native-slot`           | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-range`                 | `ion-range#native-slot`                 | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-searchbar`             | `ion-searchbar#native-slot`             | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-select`                | `ion-select#native-slot`                | ⭕️      | The host is supported. Its separately presented options overlay is not part of the host image.      |
| `ion-select-option`         | `ion-select-option#native-slot`         | ❌      | Configuration for ion-select; no standalone rendered box. Select ion-select instead.                |
| `ion-toggle`                | `ion-toggle#native-slot`                | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-datetime`              | `ion-datetime#native-slot`              | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-datetime-button`       | `ion-datetime-button#native-slot`       | ⭕️      | Connect the intended ion-datetime; the opened picker is a separate surface.                         |
| `ion-picker`                | `ion-picker#native-slot`                | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-picker-column`         | `ion-picker-column#native-slot`         | ⭕️      | Use the visible host with its intended layout box.                                                  |
| `ion-picker-column-option`  | `ion-picker-column-option#native-slot`  | ⭕️      | A rendered picker option, unlike the non-rendered ion-select-option. Keep its picker-column parent. |

### Content and layout

| Container element | Example                      | Support | Notes                                                                                          |
| ----------------- | ---------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `ion-app`         | `ion-app#native-slot`        | ⭕️      | Targets the whole app-sized box, not one nested control.                                       |
| `ion-content`     | `ion-content#native-slot`    | ⭕️      | Targets the outer content surface; for one scrolled control, select its own container instead. |
| `ion-grid`        | `ion-grid#native-slot`       | ⭕️      | Use the visible host with its intended layout box.                                             |
| `ion-row`         | `ion-row#native-slot`        | ⭕️      | Use the visible host with its intended layout box.                                             |
| `ion-col`         | `ion-col#native-slot`        | ⭕️      | Use the visible host with its intended layout box.                                             |
| `ion-split-pane`  | `ion-split-pane#native-slot` | ⭕️      | Targets the full split layout; select a child container for one pane.                          |

### Cards, text and media

| Container element   | Example                         | Support | Notes                                                                                 |
| ------------------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `ion-card`          | `ion-card#native-slot`          | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-card-content`  | `ion-card-content#native-slot`  | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-card-header`   | `ion-card-header#native-slot`   | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-card-title`    | `ion-card-title#native-slot`    | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-card-subtitle` | `ion-card-subtitle#native-slot` | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-text`          | `ion-text#native-slot`          | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-label`         | `ion-label#native-slot`         | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-note`          | `ion-note#native-slot`          | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-badge`         | `ion-badge#native-slot`         | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-chip`          | `ion-chip#native-slot`          | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-avatar`        | `ion-avatar#native-slot`        | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-thumbnail`     | `ion-thumbnail#native-slot`     | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-img`           | `ion-img#native-slot`           | ⭕️      | Select the Ionic host, not the internal HTML img. Wait for the intended image size.   |
| `ion-icon`          | `ion-icon#native-slot`          | ⭕️      | Use the visible host with its intended layout box.                                    |
| `ion-skeleton-text` | `ion-skeleton-text#native-slot` | ⭕️      | The image preserves one captured state; it does not continue the indicator animation. |
| `ion-spinner`       | `ion-spinner#native-slot`       | ⭕️      | The image preserves one captured state; it does not continue the indicator animation. |
| `ion-progress-bar`  | `ion-progress-bar#native-slot`  | ⭕️      | The image preserves one captured state; it does not continue the indicator animation. |

### Lists and gestures

| Container element             | Example                                   | Support | Notes                                                                                   |
| ----------------------------- | ----------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `ion-accordion`               | `ion-accordion#native-slot`               | ⭕️      | Targets the current accordion box; expansion changes require a geometry update.         |
| `ion-accordion-group`         | `ion-accordion-group#native-slot`         | ⭕️      | Targets the group box, including its current expansion state.                           |
| `ion-list`                    | `ion-list#native-slot`                    | ⭕️      | Use the visible host with its intended layout box.                                      |
| `ion-list-header`             | `ion-list-header#native-slot`             | ⭕️      | Use the visible host with its intended layout box.                                      |
| `ion-item`                    | `ion-item#native-slot`                    | ⭕️      | Use the visible host with its intended layout box.                                      |
| `ion-item-divider`            | `ion-item-divider#native-slot`            | ⭕️      | Use the visible host with its intended layout box.                                      |
| `ion-item-group`              | `ion-item-group#native-slot`              | ⭕️      | Use the visible host with its intended layout box.                                      |
| `ion-item-sliding`            | `ion-item-sliding#native-slot`            | ⭕️      | Targets the whole sliding row; the image does not implement the swipe gesture.          |
| `ion-item-options`            | `ion-item-options#native-slot`            | ⭕️      | Only while the options are revealed by the parent sliding item.                         |
| `ion-item-option`             | `ion-item-option#native-slot`             | ⭕️      | Only while the parent item-options is revealed.                                         |
| `ion-infinite-scroll`         | `ion-infinite-scroll#native-slot`         | ⭕️      | Requires a visible, nonzero box; loading and scroll behavior stay with Ionic.           |
| `ion-infinite-scroll-content` | `ion-infinite-scroll-content#native-slot` | ⭕️      | The image freezes the current loading indicator.                                        |
| `ion-refresher`               | `ion-refresher#native-slot`               | ⭕️      | Only in its visible active state inside ion-content; hidden idle state is not eligible. |
| `ion-refresher-content`       | `ion-refresher-content#native-slot`       | ⭕️      | Use within an active refresher; the image freezes the current indicator.                |
| `ion-reorder`                 | `ion-reorder#native-slot`                 | ⭕️      | Keep the item/reorder-group context; the image does not implement dragging.             |
| `ion-reorder-group`           | `ion-reorder-group#native-slot`           | ⭕️      | Targets the whole group; ordering and drag behavior remain with Ionic.                  |

### Navigation and tabs

| Container element     | Example                           | Support | Notes                                                                                        |
| --------------------- | --------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `ion-breadcrumb`      | `ion-breadcrumb#native-slot`      | ⭕️      | Use the visible host with its intended layout box.                                           |
| `ion-breadcrumbs`     | `ion-breadcrumbs#native-slot`     | ⭕️      | Use the visible host with its intended layout box.                                           |
| `ion-nav`             | `ion-nav#native-slot`             | ⭕️      | Targets the navigation viewport; use the current page container for a page-specific surface. |
| `ion-nav-link`        | `ion-nav-link#native-slot`        | ⭕️      | Give this action wrapper an inline-block/block box.                                          |
| `ion-router`          | `ion-router#native-slot`          | ❌      | Routing configuration, not a visible surface. Select the rendered page container.            |
| `ion-router-link`     | `ion-router-link#native-slot`     | ⭕️      | Give this action wrapper an inline-block/block box.                                          |
| `ion-router-outlet`   | `ion-router-outlet#native-slot`   | ⭕️      | Targets the outlet viewport; use the active page container for page-specific placement.      |
| `ion-route`           | `ion-route#native-slot`           | ❌      | Route definition, not a visible surface. Select the rendered page container.                 |
| `ion-route-redirect`  | `ion-route-redirect#native-slot`  | ❌      | Redirect definition, not a visible surface. Select the rendered page container.              |
| `ion-tabs`            | `ion-tabs#native-slot`            | ⭕️      | Targets the tabs viewport. Use ion-tab-bar for only the bar.                                 |
| `ion-tab`             | `ion-tab#native-slot`             | ⭕️      | Only the active, visible tab is eligible.                                                    |
| `ion-tab-bar`         | `ion-tab-bar#native-slot`         | ⭕️      | The bar is one surface; use ion-tab-button for individual tabs.                              |
| `ion-tab-button`      | `ion-tab-button#native-slot`      | ⭕️      | Use the visible host with its intended layout box.                                           |
| `ion-segment`         | `ion-segment#native-slot`         | ⭕️      | The segment is one surface; use ion-segment-button for an individual control.                |
| `ion-segment-button`  | `ion-segment-button#native-slot`  | ⭕️      | Use the visible host with its intended layout box.                                           |
| `ion-segment-view`    | `ion-segment-view#native-slot`    | ⭕️      | Targets the view viewport; individual pages use ion-segment-content.                         |
| `ion-segment-content` | `ion-segment-content#native-slot` | ⭕️      | Use the visible segment page, not an offscreen page.                                         |

### Overlays, menus and FAB

| Container element  | Example                        | Support | Notes                                                                                                                                         |
| ------------------ | ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ion-action-sheet` | `ion-action-sheet#native-slot` | ⭕️      | Only while presented. Targets the overlay host box, not automatically its inner panel; prefer a container inside the overlay for one control. |
| `ion-alert`        | `ion-alert#native-slot`        | ⭕️      | Only while presented. Targets the overlay host box, not automatically its inner panel; prefer a container inside the overlay for one control. |
| `ion-modal`        | `ion-modal#native-slot`        | ⭕️      | Only while presented. Targets the overlay host box, not automatically its inner panel; prefer a container inside the overlay for one control. |
| `ion-popover`      | `ion-popover#native-slot`      | ⭕️      | Only while presented. Targets the overlay host box, not automatically its inner panel; prefer a container inside the overlay for one control. |
| `ion-loading`      | `ion-loading#native-slot`      | ⭕️      | Only while presented. Targets the overlay host box, not automatically its inner panel; prefer a container inside the overlay for one control. |
| `ion-toast`        | `ion-toast#native-slot`        | ⭕️      | Only while presented. Targets the overlay host box, not automatically its inner panel; prefer a container inside the overlay for one control. |
| `ion-backdrop`     | `ion-backdrop#native-slot`     | ⭕️      | A decorative covering surface. This does not configure overlay detection or native z-order.                                                   |
| `ion-menu`         | `ion-menu#native-slot`         | ⭕️      | Only while presented with a visible box; its open/close behavior remains with Ionic.                                                          |
| `ion-menu-toggle`  | `ion-menu-toggle#native-slot`  | ⭕️      | Requires visible content; use inline-block/block and account for autoHide.                                                                    |
| `ion-fab`          | `ion-fab#native-slot`          | ⭕️      | Use the visible host with its intended layout box.                                                                                            |
| `ion-fab-button`   | `ion-fab-button#native-slot`   | ⭕️      | The button is a surface independently of its parent FAB group.                                                                                |
| `ion-fab-list`     | `ion-fab-list#native-slot`     | ⭕️      | Only while expanded; retain its ion-fab parent and side placement.                                                                            |

### Internal component

| Container element  | Example                         | Support | Notes                                                                                                                              |
| ------------------ | ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ion-select-modal` | Internal select overlay content | ❌      | Shipped by Ionic 9.0.9 but not a public destination contract. Select the public ion-select host or an application-owned container. |

## Wrapping an unsupported element

Select `#seat-projection`, not the HTML `select`:

```html
<span id="seat-projection" style="display: inline-block; width: 12rem; height: 2.75rem">
  <select aria-label="Seat" style="width: 100%; height: 100%">
    <option>Any seat</option>
  </select>
</span>
```

The control's DOM, value and event listeners survive handoff. The plugin still owns native behavior and value synchronization; the prepared image does not accept input.

## Verification scope

Temporary Chromium and WebKit probes exercise the Ionic inventory with an explicit layout box, required parents and visible states. A solid-color prepared image checks placement and visible pixel coverage; the probes also check original child identity/value preservation and removal of Engine images on teardown. Configuration elements are checked for the absence of a renderable box. The refresher probe selects its active CSS state; it does not validate the pull gesture. Animated loading indicators can change between the before/after captures.

In both browsers, all 90 supported public Ionic elements had zero measured image-frame difference, full solid-color coverage in the inspected interior, preserved original children/values and no retained Engine image after destruction. The four public configuration elements had no renderable box. The internal component was also probed but remains outside the supported public contract. HTML probes cover 41 element/layout combinations, including open and closed shadow roots.

These are DOM-container checks, not native capture, SDK eligibility or complete Ionic interaction tests. They do not guarantee every theme, closed-shadow implementation or application stylesheet. The probes are not part of the library's permanent test suite.
