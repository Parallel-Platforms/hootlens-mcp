/*
 * Pages worth recording: pages that visitors reach from recorded pages but that Hoot Lens does not record.
 *
 * Click records do not carry where a link goes. What is available is the replay itself: its first snapshot holds each
 * link's `href` (query string and fragment already removed, and not kept at all under the strict preset). A clicked
 * element's node id then names the link it belongs to. This module is pure: it reads the events and clicks of one
 * recording and returns the in-site paths its link clicks led to. The API gathers recordings and applies page targeting.
 */
import { pathSegments } from './targeting';

interface SnapshotNode { id?: unknown; tagName?: unknown; attributes?: unknown; childNodes?: unknown }
interface Entry { parent?: number; tag?: string; href?: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Walks serialized rrweb nodes (a snapshot or a mutation's added subtree) into `nodes`, without recursion. */
function indexTree(root: unknown, parent: number | undefined, nodes: Map<number, Entry>): void {
  const stack: { node: unknown; parent: number | undefined }[] = [{ node: root, parent }];
  let budget = 200_000;
  while (stack.length && budget-- > 0) {
    const { node, parent: parentId } = stack.pop()!;
    if (!isObject(node)) continue;
    const item = node as SnapshotNode;
    const id = typeof item.id === 'number' ? item.id : undefined;
    if (id !== undefined) {
      const attributes = isObject(item.attributes) ? item.attributes : undefined;
      const href = attributes && typeof attributes.href === 'string' ? attributes.href : undefined;
      nodes.set(id, { ...(parentId !== undefined ? { parent: parentId } : {}), ...(typeof item.tagName === 'string' ? { tag: item.tagName.toLowerCase() } : {}), ...(href !== undefined ? { href } : {}) });
    }
    if (Array.isArray(item.childNodes)) for (const child of item.childNodes) stack.push({ node: child, parent: id ?? parentId });
  }
}

/** Every node a recording's snapshots and later additions describe, with its parent, tag and link target. */
export function indexReplayNodes(events: readonly { type: number; data: unknown }[]): Map<number, Entry> {
  const nodes = new Map<number, Entry>();
  for (const event of events) {
    if (!isObject(event.data)) continue;
    if (event.type === 2) indexTree(event.data.node, undefined, nodes);
    else if (event.type === 3 && event.data.source === 0 && Array.isArray(event.data.adds)) {
      for (const add of event.data.adds) {
        if (isObject(add)) indexTree(add.node, typeof add.parentId === 'number' ? add.parentId : undefined, nodes);
      }
    }
    // Attribute changes keep a link current when a script rewrites it.
    if (event.type === 3 && event.data.source === 0 && Array.isArray(event.data.attributes)) {
      for (const change of event.data.attributes) {
        if (!isObject(change) || typeof change.id !== 'number' || !isObject(change.attributes)) continue;
        const href = change.attributes.href;
        const entry = nodes.get(change.id);
        if (entry && typeof href === 'string') entry.href = href;
      }
    }
  }
  return nodes;
}

/** The href of the link a clicked node belongs to: the node itself or its nearest `a` ancestor. Undefined when it is not inside a link. */
export function linkHrefOfNode(nodes: ReadonlyMap<number, Entry>, nodeId: number): string | undefined {
  let current: number | undefined = nodeId;
  for (let depth = 0; current !== undefined && depth < 40; depth++) {
    const entry = nodes.get(current);
    if (!entry) return undefined;
    if (entry.tag === 'a') return entry.href;
    current = entry.parent;
  }
  return undefined;
}

/**
 * The in-site path a link goes to, or undefined for other sites, mail and phone links, scripts, downloads and links that
 * stay on the page. `from` is the path of the page the link is on (for relative links); `origins` are the site's allowed origins.
 */
export function inSiteLinkPath(href: string, from: string, origins: readonly string[]): string | undefined {
  const text = href.trim();
  if (!text || text.startsWith('#') || /^(?:javascript|mailto|tel|sms|data|blob):/i.test(text)) return undefined;
  const base = origins[0] ?? 'https://site.invalid';
  let url: URL;
  try { url = new URL(text, new URL(from.startsWith('/') ? from : `/${from}`, base)); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (/^https?:\/\//i.test(text) || text.startsWith('//')) {
    if (!origins.includes(url.origin)) return undefined;
  }
  const segments = pathSegments(url.pathname);
  const path = segments.length ? `/${segments.join('/')}` : '/';
  return path === pathSegmentsToPath(pathSegments(from)) ? undefined : path;
}

const pathSegmentsToPath = (segments: string[]): string => (segments.length ? `/${segments.join('/')}` : '/');

/** One page visitors went to from recorded pages that is not itself recorded. */
export interface PageSuggestion {
  /** The path, without query string. */
  path: string;
  /** Link clicks that led there in the recordings read. */
  clicks: number;
  /** Distinct visits that clicked such a link. */
  visits: number;
  /** Recorded pages the links were on, most clicks first, at most three. */
  from: string[];
  /** A settings change that starts recording it. Pass it to preview_settings_change. */
  change: { targeting: { addInclude: string[] } } | { targeting: { removeExclude: string[] } };
  /** `excluded` when an exclude rule keeps it out, otherwise `not-included` (the site records only listed pages). */
  reason: 'excluded' | 'not-included';
  /** The exclude rule responsible when the reason is `excluded`. */
  rule?: string;
}

/** GET /v1/projects/:projectId/page-suggestions */
export interface PageSuggestions {
  suggestions: PageSuggestion[];
  /** Recordings read and how many of them had link clicks with a known destination. */
  recordings: { read: number; withLinks: number };
  /** Why the list may be empty or short, in plain words. Absent when there is nothing to explain. */
  note?: string;
}
