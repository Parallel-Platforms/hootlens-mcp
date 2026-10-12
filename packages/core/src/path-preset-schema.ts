/** Validation for per-path privacy presets. Separate from path-privacy.ts, which the browser tracker bundles and which must not pull in zod. */
import { z } from 'zod';
import { MAX_PATH_PRESETS, PATH_PRESETS } from './path-privacy';
import { targetingRuleError } from './targeting';

export const pathPresetSchema = z.object({
  match: z.string().superRefine((rule, ctx) => {
    const message = targetingRuleError(rule);
    if (message) ctx.addIssue({code: 'custom', message});
  }),
  preset: z.enum(PATH_PRESETS),
});
/** Per-path privacy presets (see path-privacy.ts). They can only make capture stricter on the pages they match. */
export const pathPresetsSchema = z.array(pathPresetSchema).max(MAX_PATH_PRESETS)
  .refine(rules => new Set(rules.map(rule => rule.match)).size === rules.length, 'Each path can have one preset');
