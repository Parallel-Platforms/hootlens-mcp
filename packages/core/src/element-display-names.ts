/*
 * Team-authored display names for elements. One name per element, keyed by the selector that heatmaps and findings
 * list (a data-hoot-id selector is the stable one). Names live on the project and are written by an owner or editor.
 * They are never read from visitors: nothing a visitor typed or saw can become a name.
 */

import { z } from 'zod';

export const ELEMENT_DISPLAY_NAME_MAX = 60;
/** The longest key: a selector as the tracker records it (Click.selector allows 300). */
export const ELEMENT_KEY_MAX = 300;
export const MAX_ELEMENT_NAMES = 200;

// Control characters and bidirectional overrides never belong in a name or a key.
const CONTROL_CHARS = '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]';

/** What the team called one element. `key` is the element's selector, exactly as findings and heatmaps list it. */
export interface ElementDisplayName {
  key: string;
  name: string;
  updatedAt: number;
  /** The signed-in user who last set it. */
  updatedBy?: string;
}

/** PUT /v1/projects/:projectId/element-names. The API also strips control characters and rejects markup (see validateElementDisplayName). */
export const elementDisplayNameInputSchema = z.object({
  key: z.string().min(1).max(ELEMENT_KEY_MAX).describe('The element\'s selector exactly as findings and heatmaps list it. A data-hoot-id selector is the stable one.'),
  name: z.string().min(1).max(ELEMENT_DISPLAY_NAME_MAX).describe('What the team calls the element. Plain words, no markup.'),
});

/** GET /v1/projects/:projectId/element-names */
export interface ElementDisplayNameList { names: ElementDisplayName[]; }

export type ElementNameCheck = { ok: true; name: string } | { ok: false; error: string };

/**
 * Cleans a typed name: control characters become spaces and runs of whitespace collapse. Returns the problem in plain
 * words when the name cannot be used: empty, too long, or containing markup.
 */
export function validateElementDisplayName(value: unknown): ElementNameCheck {
  if (typeof value !== 'string') return { ok: false, error: 'Enter a name.' };
  const name = value.replace(new RegExp(CONTROL_CHARS, 'g'), ' ').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, error: 'Enter a name.' };
  if ([...name].length > ELEMENT_DISPLAY_NAME_MAX) return { ok: false, error: `Use ${ELEMENT_DISPLAY_NAME_MAX} characters or fewer.` };
  if (/[<>]/.test(name) || /&(?:#\d+|#x[0-9a-f]+|[a-z]{2,8});/i.test(name)) return { ok: false, error: 'Use plain words, without markup.' };
  return { ok: true, name };
}

/** A key is a selector as recorded: bounded, with no control characters and no padding. */
export const isElementKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= ELEMENT_KEY_MAX && !new RegExp(CONTROL_CHARS).test(value) && value === value.trim();

/** Names by key, for helpers that take a lookup. A later entry wins. */
export function elementNameLookup(entries: readonly Pick<ElementDisplayName, 'key' | 'name'>[] | undefined): ReadonlyMap<string, string> {
  return new Map((entries ?? []).map(entry => [entry.key, entry.name]));
}

/** `name` set on each row whose selector has a team name; rows without one are returned as they are. */
export function withElementNames<T extends { selector: string }>(rows: readonly T[], lookup: ReadonlyMap<string, string>): (T & { name?: string })[] {
  if (!lookup.size) return [...rows];
  return rows.map(row => {
    const name = lookup.get(row.selector);
    return name ? { ...row, name } : row;
  });
}
