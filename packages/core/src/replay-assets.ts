/*
 * Replay asset rewriting. Recorded rrweb events name customer asset URLs (images, stylesheets, fonts,
 * CSS backgrounds). Those URLs are untrusted: a forged batch can name any address, and a browser that
 * loads one tells its host the viewer's IP and can be used to probe CSS. Replays therefore load assets
 * only from a first-party endpoint (services/api/src/asset-proxy.ts), and this module rewrites every
 * URL that would load into one the caller chooses.
 *
 * The same code runs in two places with different `replace` callbacks:
 * - the API signs each URL for the proxy before it returns events (the dashboard never sees them unsigned);
 * - the dashboard confines whatever it receives to its own origin and the API (defense in depth).
 *
 * Pure functions with no Node or browser APIs beyond URL and structuredClone.
 */

/** Stands in for a URL that must not load. Valid in CSS, attributes and srcset (no trailing comma or space). */
export const BLOCKED_ASSET_URL = 'data:,0';

/** Longest URL the proxy accepts and the rewriter will emit. */
export const MAX_ASSET_URL_LENGTH = 2048;

export interface ReplayAssetOptions {
  /** Absolute page URL used to resolve relative URLs when it is known. Usually absent: rrweb records absolute URLs. */
  base?: string;
  /**
   * Called for every URL that would cause a load. `absolute` is the resolved http(s) URL without a fragment, or
   * undefined for anything else (a relative URL with no base, another scheme). Return the URL to use instead.
   * `data:`, `blob:`, `about:` and fragment-only references are kept and never reach this callback.
   */
  replace(raw: string, absolute: string | undefined): string;
}

type Mapper = (raw: string) => string;

const KEEP = /^(?:data:|blob:|about:|#)/i;

/** The mapping applied to one URL string. Empty strings stay empty. */
function mapper(options: ReplayAssetOptions, base: () => string | undefined): Mapper {
  return raw => {
    const text = raw.trim();
    if (!text || KEEP.test(text)) return raw;
    let absolute: string | undefined;
    try {
      const resolved = /^\/\//.test(text) && !base() ? new URL(`https:${text}`) : new URL(text, base());
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        resolved.hash = '';
        absolute = resolved.href;
      }
    } catch { absolute = undefined; }
    if (absolute && absolute.length > MAX_ASSET_URL_LENGTH) absolute = undefined;
    return options.replace(raw, absolute);
  };
}

/* -------------------------------------------------------------------------- CSS */

const IDENT_START = /[A-Za-z_\u0080-￿\\-]/;
const IDENT_CHAR = /[A-Za-z0-9_\u0080-￿\\-]/;
const URL_STRING_FUNCTIONS = new Set(['image-set', '-webkit-image-set', 'src', 'image']);

/** Decodes CSS escapes in an identifier or URL ( `\72` is `r`, `\(` is `(` ). */
function unescapeCss(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_, hex: string | undefined, other: string | undefined) => {
    if (hex === undefined) return other ?? '';
    const code = parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
  });
}

function cssString(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ').replace(/\f/g, '\\c ')}"`;
}

/** Reads a quoted string at `start`. Returns the decoded value and the index after it. A bad string ends at an unescaped newline. */
function readString(css: string, start: number): { value: string; end: number; closed: boolean } {
  const quote = css[start]!;
  let i = start + 1;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return { value: unescapeCss(css.slice(start + 1, i)), end: i + 1, closed: true };
    if (c === '\n') break;
    i++;
  }
  return { value: unescapeCss(css.slice(start + 1, Math.min(i, css.length))), end: Math.min(i, css.length), closed: false };
}

/** Reads an identifier at `start` (escapes included). Returns raw text, decoded name and end index. */
function readIdent(css: string, start: number): { raw: string; name: string; end: number } {
  let i = start;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '\\') {
      // An escape is a hex run (up to six digits and one optional space) or one literal character.
      const rest = /^\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n])/.exec(css.slice(i, i + 9));
      if (!rest) break;
      i += rest[0].length;
      continue;
    }
    if (!IDENT_CHAR.test(c)) break;
    i++;
  }
  const raw = css.slice(start, i);
  return { raw, name: unescapeCss(raw).toLowerCase(), end: i };
}

/**
 * Rewrites every URL a stylesheet or declaration would load: `url(...)` (quoted or not, with escapes),
 * `@import "..."`, and strings inside `image-set()`. Comments and other strings are left alone. A `url(`
 * token that does not parse is replaced with a blocked URL rather than guessed at, so the browser cannot
 * read it differently from this scanner.
 */
export function rewriteCssUrls(css: string, map: Mapper): string {
  let out = '';
  let i = 0;
  let importPending = false;
  const functions: string[] = [];
  const emit = (raw: string) => `url(${cssString(map(raw))})`;
  while (i < css.length) {
    const c = css[i]!;
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const string = readString(css, i);
      const top = functions[functions.length - 1];
      if (string.closed && (importPending || (top !== undefined && URL_STRING_FUNCTIONS.has(top)))) {
        out += cssString(map(string.value));
      } else out += css.slice(i, string.end);
      importPending = false;
      i = string.end;
      continue;
    }
    if (c === '@') {
      const ident = readIdent(css, i + 1);
      if (ident.name === 'import') importPending = true;
      out += css.slice(i, ident.end);
      i = Math.max(ident.end, i + 1);
      continue;
    }
    if (c === ';') importPending = false;
    if (c === '(') { functions.push(''); out += c; i++; continue; }
    if (c === ')') { functions.pop(); out += c; i++; continue; }
    if (IDENT_START.test(c) && (i === 0 || !IDENT_CHAR.test(css[i - 1]!))) {
      const ident = readIdent(css, i);
      if (css[ident.end] === '(' && ident.name === 'url') {
        // url( ... )
        let j = ident.end + 1;
        while (j < css.length && /\s/.test(css[j]!)) j++;
        const q = css[j];
        if (q === '"' || q === "'") {
          const string = readString(css, j);
          let k = string.end;
          while (k < css.length && /\s/.test(css[k]!)) k++;
          if (string.closed && css[k] === ')') { out += emit(string.value); i = k + 1; }
          else { // malformed: swallow through the closing parenthesis
            const close = css.indexOf(')', string.end);
            out += `url(${cssString(map(BLOCKED_ASSET_URL))})`;
            i = close < 0 ? css.length : close + 1;
          }
        } else {
          let k = j;
          let bad = false;
          while (k < css.length && css[k] !== ')') {
            const ch = css[k]!;
            if (ch === '\\') { k += 2; continue; }
            if (ch === '"' || ch === "'" || ch === '(') bad = true;
            k++;
          }
          const body = css.slice(j, Math.min(k, css.length));
          const trimmed = body.replace(/\s+$/, '');
          // Whitespace inside the token (other than trailing) makes it a bad url token.
          if (/\s/.test(trimmed.replace(/\\[\s\S]/g, ''))) bad = true;
          out += k >= css.length || bad ? `url(${cssString(BLOCKED_ASSET_URL)})` : emit(unescapeCss(trimmed));
          i = Math.min(k + 1, css.length);
        }
        importPending = false;
        continue;
      }
      if (css[ident.end] === '(') {
        functions.push(ident.name);
        out += css.slice(i, ident.end + 1);
        i = ident.end + 1;
        continue;
      }
      out += css.slice(i, ident.end);
      i = Math.max(ident.end, i + 1);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/* -------------------------------------------------------------------------- srcset */

/** Rewrites each candidate URL of a srcset or imagesrcset value (HTML parsing rules: URLs may contain commas). */
export function rewriteSrcset(value: string, map: Mapper): string {
  const parts: string[] = [];
  let i = 0;
  const space = /[ \t\n\r\f]/;
  while (i < value.length) {
    while (i < value.length && (space.test(value[i]!) || value[i] === ',')) i++;
    if (i >= value.length) break;
    let j = i;
    while (j < value.length && !space.test(value[j]!)) j++;
    let url = value.slice(i, j);
    let descriptors = '';
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      i = j;
      let depth = 0;
      let k = i;
      while (k < value.length && (depth > 0 || value[k] !== ',')) {
        if (value[k] === '(') depth++;
        else if (value[k] === ')' && depth > 0) depth--;
        k++;
      }
      descriptors = value.slice(i, k).trim();
      j = k;
    }
    parts.push(`${map(url)}${descriptors ? ` ${descriptors}` : ''}`);
    i = j;
  }
  return parts.join(', ');
}

/* -------------------------------------------------------------------------- rrweb events */

interface KnownNode { tag?: string; style?: boolean }

/** Tags whose `src` loads an image. */
const IMAGE_SRC_TAGS = new Set(['img', 'source', 'input', 'image', 'feimage']);
/** Tags whose `src` or `data` would load media, plugins or scripts. The proxy serves none of these. */
const NEVER_LOAD_TAGS = new Set(['video', 'audio', 'track', 'embed', 'object', 'script']);
const NO_HREF_TAGS = new Set(['a', 'area', 'use']);

class EventRewriter {
  private readonly known = new Map<number, KnownNode>();
  private base: string | undefined;
  private readonly map: Mapper;

  constructor(options: ReplayAssetOptions) {
    this.base = options.base;
    this.map = mapper(options, () => this.base);
  }

  private blockUnlessInline(raw: string): string {
    return KEEP.test(raw.trim()) ? raw : BLOCKED_ASSET_URL;
  }

  /** The new value for one attribute, given its element's tag and (for source) its parent's tag. */
  attribute(tag: string | undefined, parentTag: string | undefined, rawName: string, value: unknown): unknown {
    const name = rawName.toLowerCase();
    if (typeof value !== 'string') return value;
    if (name === 'style' || name === '_csstext') return rewriteCssUrls(value, this.map);
    if (tag === 'base' && name === 'href') return BLOCKED_ASSET_URL;
    if (tag !== undefined && NEVER_LOAD_TAGS.has(tag) && (name === 'src' || name === 'data')) return this.blockUnlessInline(value);
    if (name === 'srcset' || name === 'imagesrcset') return rewriteSrcset(value, this.map);
    if (name === 'poster' || name === 'background') return this.map(value);
    if (name === 'src') {
      if (tag === 'source' && (parentTag === 'video' || parentTag === 'audio')) return this.blockUnlessInline(value);
      return tag === undefined || IMAGE_SRC_TAGS.has(tag) ? this.map(value) : value;
    }
    if (name === 'href' || name === 'xlink:href') {
      return tag !== undefined && NO_HREF_TAGS.has(tag) ? value : this.map(value);
    }
    return value;
  }

  private attributes(tag: string, parentTag: string | undefined, attributes: Record<string, unknown>) {
    for (const name of Object.keys(attributes)) attributes[name] = this.attribute(tag, parentTag, name, attributes[name]);
  }

  /** Walks a serialized rrweb node tree in place. Iterative, so a deep document cannot exhaust the stack. */
  node(root: unknown, parentTag?: string) {
    const stack: { node: unknown; parentTag: string | undefined }[] = [{ node: root, parentTag }];
    while (stack.length) {
      const { node, parentTag: parent } = stack.pop()!;
      if (!node || typeof node !== 'object') continue;
      const item = node as Record<string, unknown>;
      const id = typeof item.id === 'number' ? item.id : undefined;
      if (item.type === 2 && typeof item.tagName === 'string') {
        const tag = item.tagName.toLowerCase();
        if (item.attributes && typeof item.attributes === 'object') this.attributes(tag, parent, item.attributes as Record<string, unknown>);
        if (id !== undefined) this.known.set(id, { tag });
        if (Array.isArray(item.childNodes)) for (const child of item.childNodes) stack.push({ node: child, parentTag: tag });
      } else if (item.type === 3 && typeof item.textContent === 'string') {
        const style = item.isStyle === true || parent === 'style';
        if (style) item.textContent = rewriteCssUrls(item.textContent, this.map);
        if (id !== undefined) this.known.set(id, { style });
      } else if (item.type === 0 && Array.isArray(item.childNodes)) {
        for (const child of item.childNodes) stack.push({ node: child, parentTag: undefined });
      }
    }
  }

  private css(value: unknown): unknown { return typeof value === 'string' ? rewriteCssUrls(value, this.map) : value; }

  private rules(list: unknown) {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (entry && typeof entry === 'object' && typeof (entry as { rule?: unknown }).rule === 'string') {
        (entry as { rule: string }).rule = rewriteCssUrls((entry as { rule: string }).rule, this.map);
      }
    }
  }

  private mutation(data: Record<string, unknown>) {
    if (Array.isArray(data.adds)) {
      for (const add of data.adds as Record<string, unknown>[]) {
        const parent = typeof add.parentId === 'number' ? this.known.get(add.parentId)?.tag : undefined;
        this.node(add.node, parent);
      }
    }
    if (Array.isArray(data.attributes)) {
      for (const change of data.attributes as Record<string, unknown>[]) {
        const known = typeof change.id === 'number' ? this.known.get(change.id) : undefined;
        const attributes = change.attributes;
        if (!attributes || typeof attributes !== 'object') continue;
        for (const [name, value] of Object.entries(attributes as Record<string, unknown>)) {
          if (value !== null && typeof value === 'object') {
            // A style object: property to value, [value, priority] or false.
            const declarations = value as Record<string, unknown>;
            for (const [property, declaration] of Object.entries(declarations)) {
              if (typeof declaration === 'string') declarations[property] = rewriteCssUrls(declaration, this.map);
              else if (Array.isArray(declaration) && typeof declaration[0] === 'string') declaration[0] = rewriteCssUrls(declaration[0], this.map);
            }
            continue;
          }
          (attributes as Record<string, unknown>)[name] = this.attribute(known?.tag, undefined, name, value);
        }
      }
    }
    if (Array.isArray(data.texts)) {
      for (const text of data.texts as Record<string, unknown>[]) {
        if (typeof text.id === 'number' && this.known.get(text.id)?.style && typeof text.value === 'string') text.value = rewriteCssUrls(text.value, this.map);
      }
    }
  }

  event(event: { type?: unknown; data?: unknown }) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const record = data as Record<string, unknown>;
    if (event.type === 4) {
      if (typeof record.href === 'string' && /^https?:\/\//i.test(record.href) && !this.base) {
        try { this.base = new URL(record.href).href; } catch { /* keep no base */ }
      }
    } else if (event.type === 2) {
      this.node(record.node);
    } else if (event.type === 3) {
      switch (record.source) {
        case 0: this.mutation(record); break;
        case 8:
          this.rules(record.adds);
          record.replace = this.css(record.replace);
          record.replaceSync = this.css(record.replaceSync);
          if (record.replace === undefined) delete record.replace;
          if (record.replaceSync === undefined) delete record.replaceSync;
          break;
        case 13:
          if (record.set && typeof record.set === 'object') (record.set as { value?: unknown }).value = this.css((record.set as { value?: unknown }).value);
          break;
        case 15:
          if (Array.isArray(record.styles)) for (const style of record.styles as { rules?: unknown }[]) this.rules(style.rules);
          break;
        default: break;
      }
    }
  }
}

/**
 * Returns a copy of the events with every asset URL passed through `options.replace`: element attributes
 * (img, source and image src, srcset, poster, link and SVG image href, the legacy background attribute),
 * style attributes, style element text, `_cssText` of inlined stylesheets, constructed and adopted
 * stylesheets and CSS rule mutations. Media, plugin and script sources are always blocked, and a `<base>`
 * element's href is replaced so it cannot redirect what remains. Navigation links are not rewritten.
 * The input is not modified.
 */
export function rewriteReplayEvents<T extends { type: number }>(events: readonly T[], options: ReplayAssetOptions): T[] {
  const copy = structuredClone(events) as T[];
  const rewriter = new EventRewriter(options);
  for (const event of copy) rewriter.event(event as { type?: unknown; data?: unknown });
  return copy;
}

/** A confinement mapper for the dashboard: keeps URLs on the allowed origins and blocks every other one. */
export function confineAssetUrls(allowedOrigins: readonly string[]): ReplayAssetOptions['replace'] {
  const allowed = new Set(allowedOrigins);
  return (_raw, absolute) => {
    if (absolute) {
      try { if (allowed.has(new URL(absolute).origin)) return absolute; } catch { /* blocked below */ }
    }
    return BLOCKED_ASSET_URL;
  };
}
