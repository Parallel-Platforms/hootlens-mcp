/*
 * Readable names for clicked elements. Pure helpers, no DOM.
 *
 * A name is either a label supplied by the collector (`label`, set by the tracker under the project's privacy
 * policy) or a plain-words description derived only from the selector. Nothing is guessed: the words come from
 * the tag name, a public data-hoot-id, an element id or class names that already
 * appear in the selector. The selector always stays available as secondary text.
 */

export type ElementNameSource = "custom" | "label" | "hoot-id" | "id" | "selector";

export interface ElementName {
  /** Main text shown to the reader. */
  primary: string;
  /** The raw selector, shown small and monospaced beside the primary text. */
  secondary: string;
  source: ElementNameSource;
}

const MAX_PRIMARY = 64;

const TAG_WORDS: Record<string, string> = {
  a: "link",
  button: "button",
  img: "image",
  picture: "image",
  svg: "icon",
  input: "input",
  select: "dropdown",
  textarea: "text area",
  label: "label",
  form: "form",
  summary: "disclosure",
  details: "disclosure",
  video: "video",
  audio: "audio player",
  iframe: "embedded frame",
  canvas: "canvas",
  nav: "navigation",
  header: "header",
  footer: "footer",
  main: "main area",
  section: "section",
  article: "article",
  aside: "sidebar",
  ul: "list",
  ol: "list",
  li: "list item",
  table: "table",
  tr: "table row",
  td: "table cell",
  th: "table heading",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  p: "paragraph",
  span: "text",
  div: "container",
  body: "page",
  html: "page",
};

/** Tag name in plain words. Unknown tags keep their own name. */
export function tagWord(tag: string): string {
  const lower = tag.toLowerCase();
  return TAG_WORDS[lower] ?? lower;
}

const capitalize = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

const ordinal = (n: number) => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** "confirm-visit" becomes "confirm visit". */
export function humanizeIdentifier(value: string): string {
  return value
    .replace(/\\(.)/g, "$1")
    .replace(/[-_.:]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Splits a selector at combinators that are outside brackets, parentheses and quotes. */
export function selectorSegments(selector: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const char of selector) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "[" || char === "(") {
      depth++;
      current += char;
    } else if (char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (depth === 0 && (/\s/.test(char) || char === ">" || char === "+" || char === "~")) {
      if (current) segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) segments.push(current);
  return segments;
}

interface Segment {
  tag?: string;
  hootId?: string;
  id?: string;
  classes: string[];
  nth?: number;
}

const stripGroups = (text: string) => {
  let previous = "";
  let next = text;
  while (next !== previous) {
    previous = next;
    next = next.replace(/\([^()]*\)/g, "");
  }
  return next;
};

function parseSegment(text: string): Segment {
  const nth = /:nth-(?:of-type|child)\((\d{1,4})\)/.exec(text);
  const hoot = /\[data-hoot-id=(?:"([^"]{1,80})"|'([^']{1,80})')\]/.exec(text);
  const plain = stripGroups(text).replace(/\[[^\]]*\]/g, "");
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(plain)?.[0];
  const id = /#((?:\\.|[\w-])+)/.exec(plain)?.[1];
  const classes = [...plain.matchAll(/\.((?:\\.|[\w-])+)/g)].map((match) => match[1]);
  return {
    tag,
    hootId: hoot ? (hoot[1] ?? hoot[2]) : undefined,
    id,
    classes,
    nth: nth ? Number(nth[1]) : undefined,
  };
}

const identifierOf = (segment: Segment) => segment.hootId ?? segment.id ?? segment.classes[0];

/** Container tags that say where on the page an element sits. */
const LANDMARK_TAGS = new Set(["nav", "header", "footer", "main", "aside", "form", "section", "article", "dialog"]);

/**
 * The nearest ancestor that says something about where the element is: one with a public id or class, else a landmark
 * tag. Plain wrappers (div, span, list) are skipped, so "5th container" under `main` reads "in main area".
 */
function placeOf(ancestors: Segment[]): string {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const segment = ancestors[index];
    const id = identifierOf(segment);
    const words = id ? humanizeIdentifier(id) : "";
    if (words) return segment.tag && LANDMARK_TAGS.has(segment.tag.toLowerCase()) && !words.includes(tagWord(segment.tag)) ? `${words} ${tagWord(segment.tag)}` : words;
    if (segment.tag && LANDMARK_TAGS.has(segment.tag.toLowerCase())) return tagWord(segment.tag);
  }
  return "";
}

/** Plain-words name derived only from the selector. Never reads or invents page text. */
export function describeSelector(selector: string): { primary: string; source: ElementNameSource } {
  const segments = selectorSegments(selector.trim()).map(parseSegment);
  const last = segments[segments.length - 1];
  if (!last) return { primary: "Unidentified element", source: "selector" };

  const kind = last.tag ? tagWord(last.tag) : undefined;
  const publicId = last.hootId ?? last.id;
  if (publicId) {
    const words = humanizeIdentifier(publicId);
    if (words) {
      const text = kind ? `${words} ${kind}` : words;
      return { primary: truncate(capitalize(text), MAX_PRIMARY), source: last.hootId ? "hoot-id" : "id" };
    }
  }

  const own = last.classes[0] ? humanizeIdentifier(last.classes[0]) : "";
  const parent = segments.length > 1 ? segments[segments.length - 2] : undefined;
  let text = kind ?? (own || "element");
  if (kind && last.nth) {
    text = `${ordinal(last.nth)} ${kind}`;
    const place = placeOf(segments.slice(0, -1));
    if (place) text = `${text} in ${place}`;
  } else if (kind && own) text = `${own} ${kind}`;
  if (parent && !last.nth && !(kind && own)) {
    const parentId = identifierOf(parent);
    const parentName = parentId
      ? humanizeIdentifier(parentId)
      : parent.tag
        ? `${parent.nth ? `${ordinal(parent.nth)} ` : ""}${tagWord(parent.tag)}`
        : "";
    // A plain parent (a div or list) says little, so a landmark or named ancestor further up is added as the place.
    const plain = !parentId && !(parent.tag && LANDMARK_TAGS.has(parent.tag.toLowerCase()));
    const farther = plain ? placeOf(segments.slice(0, -2)) : "";
    if (parentName) text = `${text} in ${parentName}${farther ? ` of ${farther}` : ""}`;
  }
  return { primary: truncate(capitalize(text), MAX_PRIMARY), source: "selector" };
}

/** Tags that read naturally after a quoted label: "Book a workshop" button. Containers and text say nothing, so they add no word. */
const LABELED_KIND_TAGS = new Set(["a", "button", "img", "picture", "svg", "input", "select", "textarea", "summary", "details", "label", "video", "audio", "iframe"]);

/** Longest label shown in a name, matching the tracker's cap. */
const MAX_LABEL = 60;

/**
 * Name for a clicked element. A collector label wins: it is quoted and followed by the kind of element when the
 * selector's last part shows one ("Book a workshop" button, "Our workshops" image). Whitespace is collapsed and long
 * text shortened. Without a label, a description derived from the selector.
 */
export function elementName(selector: string, label?: unknown, custom?: string): ElementName {
  // A name the team wrote always wins, under every privacy preset: people authored it, it was not recorded from visitors.
  if (custom) return { primary: custom, secondary: selector, source: "custom" };
  const text = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : "";
  if (text) {
    const last = selectorSegments(selector.trim()).map(parseSegment).pop();
    const tag = last?.tag?.toLowerCase();
    const kind = tag && LABELED_KIND_TAGS.has(tag) ? ` ${tagWord(tag)}` : "";
    return { primary: `"${truncate(text.replace(/"/g, "'"), MAX_LABEL)}"${kind}`, secondary: selector, source: "label" };
  }
  const derived = describeSelector(selector);
  return { primary: derived.primary, secondary: selector, source: derived.source };
}

/** Reads an optional `label` from a row that may or may not carry one yet. */
export const labelOf = (row: object): string | undefined => {
  const value = (row as { label?: unknown }).label;
  return typeof value === "string" ? value : undefined;
};

/**
 * A name with where it sits added, for lists where two elements would otherwise read the same. A collector label or a
 * name that already says where (" in ") is returned as is.
 */
export function elementNameWithPlace(selector: string, label?: unknown, custom?: string): ElementName {
  const base = elementName(selector, label, custom);
  if (base.source === "custom" || base.source === "label" || base.primary.includes(" in ")) return base;
  const segments = selectorSegments(selector.trim()).map(parseSegment);
  const place = placeOf(segments.slice(0, -1));
  return place ? { ...base, primary: truncate(`${base.primary} in ${place}`, MAX_PRIMARY) } : base;
}

/** The name as it reads inside a sentence: a name the team gave is quoted, as a recorded label already is. */
export const sentenceName = (name: ElementName): string => (name.source === "custom" ? `"${name.primary}"` : name.primary);
