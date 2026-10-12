/*
 * Short element context recorded with a click, so an element nothing names can still be told apart: its tag, the region
 * of the page it sits in, and (under the full and balanced presets only) the nearest heading above it and a snippet of
 * its own text. Strict captures the tag and a site-authored region only.
 *
 * The tracker computes it under the project's privacy policy (the same redaction labels use), the collector validates
 * it again, and findings, heatmaps, narratives and visit lists carry it. It is bounded: four short fields.
 */
import { z } from 'zod';

/** Longest heading or text snippet, in characters. Matches the label limit. */
export const CONTEXT_TEXT_MAX = 60;
/** Longest region name, in characters. */
export const CONTEXT_REGION_MAX = 60;
const TAG = /^[a-z][a-z0-9-]{0,23}$/;

export const elementContextSchema = z.strictObject({
  /** Tag name of the clicked element, such as div, li, p or img. */
  tag: z.string().regex(TAG).optional(),
  /** The nearest region: a `data-hoot-region`, a `data-hoot-id` on an ancestor, or a section with an id or aria-label. */
  region: z.string().min(1).max(CONTEXT_REGION_MAX).optional(),
  /** Text of the nearest h1 to h3 above the element. Full and balanced only, redacted like a label. */
  heading: z.string().min(1).max(CONTEXT_TEXT_MAX).optional(),
  /** The element's own text, shortened. Full and balanced only, redacted like a label. */
  text: z.string().min(1).max(CONTEXT_TEXT_MAX).optional(),
});
export type ElementContext = z.infer<typeof elementContextSchema>;

/** True when the context holds any field. */
export const hasContext = (context: ElementContext | undefined): context is ElementContext =>
  context !== undefined && Object.keys(context).length > 0;

const quote = (value: string) => `"${value.replace(/"/g, "'")}"`;

/**
 * The context in one phrase, such as `div "Start free" under "Plans" in pricing-cards`. Pieces the preset did not
 * capture are left out, so a strict phrase is `div in pricing-cards`. Undefined when there is nothing to say.
 */
export function describeContext(context: ElementContext | undefined): string | undefined {
  if (!hasContext(context)) return undefined;
  const parts: string[] = [];
  parts.push(context.text ? `${context.tag ?? 'element'} ${quote(context.text)}` : context.tag ?? 'element');
  if (context.heading) parts.push(`under ${quote(context.heading)}`);
  if (context.region) parts.push(`in ${context.region}`);
  return parts.join(' ');
}

/**
 * What to call an element in a sentence: a name the team gave it, else its label, else its context, else undefined. A
 * name or label is single-quoted; a context phrase is not.
 */
export function elementPhrase(input: { name?: string; label?: string; context?: ElementContext }): string | undefined {
  if (input.name) return `'${input.name}'`;
  if (input.label) return `'${input.label}'`;
  return describeContext(input.context);
}

/** The wording for an element that is not a link, button or control. Observed, not interpreted. */
export const NOT_INTERACTIVE_PHRASE = 'not a link or button';

export const TOP_SNAG_KINDS = ['pile-up', 'no-show', 'misfire'] as const;
export type TopSnagKind = (typeof TOP_SNAG_KINDS)[number];

/**
 * The element a visit had the most snag clicks on, from the visit's own recorded clicks. `count` is that element's snag
 * clicks of `kind`, which is the kind it had most. `name` is the team's name for the element, `label` and `context` are
 * what the tracker recorded (strict records no label and no text); `selector` is the element's key.
 */
export interface TopSnag {
  kind: TopSnagKind;
  count: number;
  selector: string;
  name?: string;
  label?: string;
  context?: ElementContext;
  /** False when the element is not a link, button or other control. Absent otherwise. */
  interactive?: false;
}

/** "2 pile-ups on 'Create Workspace'": the count, the kind and where. Falls back to the element kind and place when nothing names it. */
export function topSnagPhrase(snag: TopSnag): string {
  const noun = snag.kind === 'pile-up' ? 'pile-up' : snag.kind === 'no-show' ? 'no-show' : 'misfire';
  const where = elementPhrase(snag) ?? 'an unnamed element';
  const inactive = snag.interactive === false ? ` (${NOT_INTERACTIVE_PHRASE})` : '';
  return `${snag.count} ${noun}${snag.count === 1 ? '' : 's'} on ${where}${inactive}`;
}
