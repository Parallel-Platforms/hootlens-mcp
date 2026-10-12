/*
 * Source locations: `data-hoot-src="src/components/Pricing.tsx:42"`, stamped on elements by the Hoot Lens build plugins
 * (hootlens/vite and hootlens/next) so a snag can name the file and line behind it. No dependencies, so the tracker, the
 * collector and the plugins share one definition of what a valid location is.
 *
 * A location is a repository-relative path and a line: never absolute, never a URL, never above the project root. The
 * tracker, the collector and the plugins all check it with the same function, so a value that fails here is dropped,
 * not trusted.
 */

export const SOURCE_ATTRIBUTE = 'data-hoot-src';
/** Longest accepted location, in characters. */
export const SOURCE_LOCATION_MAX_LENGTH = 200;

/** One path segment: letters, digits and the punctuation framework folders use, such as `(marketing)`, `[slug]` and `@modal`. */
const SEGMENT = /^[A-Za-z0-9_@()[\]+~$.-]+$/;
const LINE = /^[1-9][0-9]{0,6}$/;

/** The location when `value` is a valid `path:line`, else undefined. */
export function parseSourceLocation(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > SOURCE_LOCATION_MAX_LENGTH) return undefined;
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return undefined;
  const path = value.slice(0, colon);
  if (!LINE.test(value.slice(colon + 1))) return undefined;
  for (const segment of path.split('/')) {
    if (!SEGMENT.test(segment) || /^\.+$/.test(segment)) return undefined;
  }
  return value;
}

export const isSourceLocation = (value: unknown): value is string => parseSourceLocation(value) !== undefined;

/** `path:line`, or undefined when the pair would not be a valid location (an unusual file name, say). */
export function formatSourceLocation(path: string, line: number): string | undefined {
  return Number.isInteger(line) ? parseSourceLocation(`${path}:${line}`) : undefined;
}
