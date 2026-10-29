/** Reflect native state without inventing component-specific input events. */
export interface NativeValueBinding {
  property?: string;
}

export const applyNativeValues = (target: HTMLElement, values: Record<string, unknown>, bindings: Record<string, NativeValueBinding>) => {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new TypeError('Native value keys must be lowercase attribute names');
    const binding = Object.hasOwn(bindings, key) ? bindings[key] : undefined;
    const property = binding?.property;
    if (
      property &&
      (!/^[a-zA-Z][\w]*$/.test(property) ||
        /^on/i.test(property) ||
        ['innerHTML', 'outerHTML', 'textContent', 'innerText', 'style', 'constructor', 'prototype'].includes(property))
    )
      throw new TypeError('Native value binding requires a data property');
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Native values must be JSON values');
    if (property) {
      const element = target as unknown as Record<string, unknown>;
      if (JSON.stringify(element[property]) !== serialized) element[property] = value;
    } else {
      const attribute = `data-native-ui-value-${key}`;
      const text = typeof value === 'string' ? value : serialized;
      if (target.getAttribute(attribute) !== text) target.setAttribute(attribute, text);
    }
  }
};
