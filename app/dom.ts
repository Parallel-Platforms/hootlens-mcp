/*
 * A very small DOM helper. Everything the viewers show that came from a recording (element names, error messages, notes,
 * page paths) is set through textContent or an attribute, never as markup, so recorded content cannot add elements or
 * script to the viewer.
 */
type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | undefined | null>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    // ARIA states are the words "true" and "false", never a bare attribute.
    if (name.startsWith('aria-') && typeof value === 'boolean') { element.setAttribute(name, String(value)); continue; }
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') element.className = String(value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

const SVG = 'http://www.w3.org/2000/svg';
export function svg(width: number, height: number, ...paths: [string, Record<string, string>?][]): SVGSVGElement {
  const root = document.createElementNS(SVG, 'svg');
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  for (const [d, extra] of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    for (const [name, value] of Object.entries(extra ?? {})) path.setAttribute(name, value);
    root.append(path);
  }
  return root;
}

const LINE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** Icons are drawn with currentColor so they follow the host's text color in light and dark. */
export const icon = {
  play: () => svg(16, 16, ['M4 2.5v11l9-5.5z', { fill: 'currentColor' }]),
  pause: () => svg(16, 16, ['M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z', { fill: 'currentColor' }]),
  restart: () => svg(16, 16, ['M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3', LINE]),
  expand: () => svg(16, 16, ['M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10', LINE]),
  collapse: () => svg(16, 16, ['M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5', LINE]),
  external: () => svg(16, 16, ['M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3', LINE]),
};

/** Marker shapes. Shape and color together, so the kind never depends on color alone. */
export type MarkerKind = 'click' | 'rage-click' | 'dead-click' | 'error-click' | 'js-error';
export function markerShape(kind: MarkerKind): SVGSVGElement {
  const cut = { stroke: 'var(--hl-surface)', 'stroke-width': '1.5', 'stroke-linecap': 'round', fill: 'none' };
  switch (kind) {
    case 'rage-click': return svg(14, 14, ['M7 1.5 13 12.5H1z', { fill: 'currentColor' }]);
    case 'dead-click': return svg(14, 14, ['M2 2h10v10H2z', { fill: 'currentColor' }]);
    case 'error-click': return svg(14, 14, ['M7 1 13 7 7 13 1 7z', { fill: 'currentColor' }], ['M5 5l4 4M9 5l-4 4', cut]);
    case 'js-error': return svg(14, 14, ['M4.2 1.5h5.6L12.5 7l-2.7 5.5H4.2L1.5 7z', { fill: 'currentColor' }], ['M7 4.2v3.4M7 9.2v.1', cut]);
    default: return svg(14, 14, ['M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z', { fill: 'currentColor' }]);
  }
}
