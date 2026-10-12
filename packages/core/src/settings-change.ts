/*
 * Settings changes: the two-step (preview, then apply) way an agent changes a site's Hoot Lens setup.
 *
 * A change names what to add or remove in five areas: page targeting, goals, funnels, privacy masks and per-path
 * privacy presets. `planSettingsChange` is pure: it checks the change against the site's current settings, computes the
 * resulting settings and a precise list of what changes. The API runs it twice, at preview and again at apply, and the
 * apply only goes through when the settings are exactly as they were at preview.
 *
 * Privacy can only get stricter through this path. Removing a mask or block selector, allowing an input's value, keeping
 * query strings, moving to a less strict preset and loosening or removing a path preset are all refused, whoever asks.
 * (The site owner does those in the dashboard.)
 */
import { z } from 'zod';
import { goalInputSchema, goalSummary, MAX_GOALS, type Goal } from './changes';
import { funnelInputSchema, MAX_FUNNELS, type Funnel } from './funnels';
import { projectPrivacy, type PrivacyPolicy, type Project } from './index';
import { pathPresetSchema } from './path-preset-schema';
import { MAX_PATH_PRESETS, PRESET_STRICTNESS, type PathPreset } from './path-privacy';
import { TARGETING_MAX_RULES, targetingRuleError } from './targeting';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const idText = z.string().regex(ID);
const rule = z.string().superRefine((value, ctx) => {
  const message = targetingRuleError(value);
  if (message) ctx.addIssue({ code: 'custom', message });
});
const selector = z.string().trim().min(1).max(200).refine(value => !/[{}<>]/.test(value), 'Invalid selector');
const rules = z.array(rule).max(TARGETING_MAX_RULES).optional();
const goalUpdate = z.intersection(z.object({ id: idText }), goalInputSchema);

/** Most items a single change may carry in each list, so a preview stays readable. */
export const SETTINGS_CHANGE_MAX_ITEMS = 10;

export const settingsChangeSchema = z.strictObject({
  /** Which pages are recorded. Include rules narrow capture to matching pages (none means every page); exclude rules always win. */
  targeting: z.strictObject({ addInclude: rules, removeInclude: rules, addExclude: rules, removeExclude: rules }).optional(),
  goals: z.strictObject({
    add: z.array(goalInputSchema).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
    update: z.array(goalUpdate).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
    remove: z.array(idText).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
  }).optional(),
  funnels: z.strictObject({
    /** Each step is a goal id or the exact name of a goal, including one added by the same change. */
    add: z.array(z.strictObject({ name: funnelInputSchema.shape.name, steps: z.array(z.string().trim().min(1).max(80)).min(2).max(8) })).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
    remove: z.array(idText).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
  }).optional(),
  /**
   * Stricter privacy only. The fields a person might expect (removing a mask, allowing an input) are accepted by the schema
   * so that the refusal can say why, instead of an unknown-field error.
   */
  privacy: z.looseObject({
    preset: z.enum(['full', 'balanced', 'strict']).optional(),
    addMaskTextSelectors: z.array(selector).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
    addBlockSelectors: z.array(selector).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
    removeUnmaskInputSelectors: z.array(selector).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
    captureQueryStrings: z.boolean().optional(),
  }).optional(),
  pathPresets: z.looseObject({
    set: z.array(pathPresetSchema).max(SETTINGS_CHANGE_MAX_ITEMS).optional(),
  }).optional(),
});
export type SettingsChange = z.infer<typeof settingsChangeSchema>;
/** POST /v1/projects/:projectId/settings-changes/preview */
export const settingsPreviewBodySchema = z.object({ changes: settingsChangeSchema });
/** POST /v1/projects/:projectId/settings-changes/apply. The token is the one the preview returned. */
export const settingsApplyBodySchema = z.object({ token: z.string().min(16).max(12_000) });

export type SettingsArea = 'targeting' | 'goals' | 'funnels' | 'privacy' | 'pathPresets';
/** Areas an editor may change: what editors can already change with their own role (goals and funnels). The rest is owner only. */
export const EDITOR_SETTINGS_AREAS: readonly SettingsArea[] = ['goals', 'funnels'];
/** Areas that change what the tracker captures, so the project's settings timestamp moves with them. */
export const CAPTURE_SETTINGS_AREAS: readonly SettingsArea[] = ['targeting', 'privacy', 'pathPresets'];

/** The project fields a settings change can touch. */
export type SettingsFields = Pick<Project, 'targeting' | 'goals' | 'funnels' | 'privacy' | 'pathPresets'>;

export interface SettingsDiffEntry {
  area: SettingsArea;
  action: 'add' | 'remove' | 'change';
  /** One plain sentence: exactly what changes. */
  summary: string;
}

export interface SettingsPlan {
  /** The settings after the change. Fields the change does not touch are copied unchanged. */
  next: SettingsFields;
  diff: SettingsDiffEntry[];
  areas: SettingsArea[];
}

/** `weakening`: refused because it would make privacy looser. `invalid`: the change does not fit the current settings. */
export class SettingsChangeError extends Error {
  constructor(message: string, readonly kind: 'invalid' | 'weakening') {
    super(message);
    this.name = 'SettingsChangeError';
  }
}
const invalid = (message: string) => new SettingsChangeError(message, 'invalid');
const weakening = (what: string) => new SettingsChangeError(`Refused: ${what} would make privacy looser. Agents can only make privacy stricter.`, 'weakening');

/** Privacy fields that exist only to loosen capture or to replace a whole list: a request naming them is a weakening attempt. */
const LOOSENING_PRIVACY_KEYS = ['removeMaskTextSelectors', 'removeBlockSelectors', 'addUnmaskInputSelectors', 'unmaskInputSelectors', 'maskTextSelectors', 'blockSelectors', 'consent', 'sampleRate', 'keepCampaignDigits'] as const;
const KNOWN_PRIVACY_KEYS = ['preset', 'addMaskTextSelectors', 'addBlockSelectors', 'removeUnmaskInputSelectors', 'captureQueryStrings'] as const;
const KNOWN_PATH_PRESET_KEYS = ['set'] as const;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(item => b.includes(item));
const quote = (value: string) => `"${value}"`;

/** Reasons the move from `current` to `next` makes privacy looser. Empty when it does not. */
export function privacyWeakening(current: PrivacyPolicy, next: PrivacyPolicy): string[] {
  const reasons: string[] = [];
  if (PRESET_STRICTNESS[next.preset] < PRESET_STRICTNESS[current.preset]) reasons.push(`moves the preset from ${current.preset} to ${next.preset}`);
  const missing = (before: readonly string[], after: readonly string[]) => before.filter(item => !after.includes(item));
  if (missing(current.maskTextSelectors, next.maskTextSelectors).length) reasons.push('removes a text mask');
  if (missing(current.blockSelectors, next.blockSelectors).length) reasons.push('removes a blocked region');
  if (missing(next.unmaskInputSelectors, current.unmaskInputSelectors).length) reasons.push('unmasks an input');
  if (next.captureQueryStrings && !current.captureQueryStrings) reasons.push('keeps query strings');
  if (next.keepCampaignDigits === true && current.keepCampaignDigits !== true) reasons.push('keeps digits in campaign tags');
  return reasons;
}

/** Reasons `next` loosens the per-path presets in `current`: a rule removed, or one changed to anything but strict. */
export function pathPresetsWeakening(current: readonly PathPreset[] | undefined, next: readonly PathPreset[] | undefined): string[] {
  const reasons: string[] = [];
  for (const before of current ?? []) {
    const after = (next ?? []).find(candidate => candidate.match === before.match);
    if (!after) reasons.push(`removes the ${before.preset} preset on ${before.match}`);
    else if (after.preset !== before.preset && after.preset !== 'strict') reasons.push(`changes ${before.match} from ${before.preset} to ${after.preset}`);
  }
  return reasons;
}

/** The areas a change touches. */
export function settingsChangeAreas(change: SettingsChange): SettingsArea[] {
  const areas: SettingsArea[] = [];
  const has = (value: object | undefined) => value !== undefined && Object.values(value).some(item => item !== undefined);
  if (has(change.targeting)) areas.push('targeting');
  if (has(change.goals)) areas.push('goals');
  if (has(change.funnels)) areas.push('funnels');
  if (has(change.privacy)) areas.push('privacy');
  if (has(change.pathPresets)) areas.push('pathPresets');
  return areas;
}

const same = (a: Goal, b: { kind: string; match: string; by?: string }): boolean => a.kind === b.kind && a.match === b.match && ('by' in a ? a.by : undefined) === b.by;

/**
 * Applies a change to the settings in memory. Throws SettingsChangeError when it cannot be applied as written or would
 * weaken privacy. Does not know about roles: the API checks `settingsChangeAreas` against the caller's role first.
 */
export function planSettingsChange(source: Partial<SettingsFields>, change: SettingsChange, context: { now: number; newId: () => string }): SettingsPlan {
  const diff: SettingsDiffEntry[] = [];
  const next: SettingsFields = { ...(source.targeting ? { targeting: source.targeting } : {}), ...(source.goals ? { goals: source.goals } : {}), ...(source.funnels ? { funnels: source.funnels } : {}), ...(source.privacy ? { privacy: source.privacy } : {}), ...(source.pathPresets ? { pathPresets: source.pathPresets } : {}) };
  const note = (area: SettingsArea, action: SettingsDiffEntry['action'], summary: string) => diff.push({ area, action, summary });

  // Privacy first, so a refused weakening is reported before anything else.
  if (change.privacy) {
    const extra = Object.keys(change.privacy).filter(key => !(KNOWN_PRIVACY_KEYS as readonly string[]).includes(key));
    if (extra.some(key => (LOOSENING_PRIVACY_KEYS as readonly string[]).includes(key))) throw weakening('Removing a mask or block selector, allowing an input or replacing a privacy list');
    if (extra.length) throw invalid(`Unknown privacy field ${extra.slice(0, 3).join(', ')}. Use preset, addMaskTextSelectors, addBlockSelectors, removeUnmaskInputSelectors or captureQueryStrings.`);
  }
  if (change.pathPresets) {
    const extra = Object.keys(change.pathPresets).filter(key => !(KNOWN_PATH_PRESET_KEYS as readonly string[]).includes(key));
    if (extra.length) throw (extra.includes('remove') ? weakening('Removing a path preset') : invalid(`Unknown pathPresets field ${extra.slice(0, 3).join(', ')}. Use set.`));
  }

  /* ------------------------------------------------------------ targeting */
  if (change.targeting) {
    const include = [...(source.targeting?.include ?? [])];
    const exclude = [...(source.targeting?.exclude ?? [])];
    const t = change.targeting;
    for (const [list, name, remove] of [[include, 'include', t.removeInclude], [exclude, 'exclude', t.removeExclude]] as const) {
      for (const item of remove ?? []) {
        const at = list.indexOf(item);
        if (at < 0) throw invalid(`There is no ${name} rule ${item} to remove.`);
        list.splice(at, 1);
        note('targeting', 'remove', `Remove ${name} rule ${item}`);
      }
    }
    for (const [list, name, add] of [[include, 'include', t.addInclude], [exclude, 'exclude', t.addExclude]] as const) {
      for (const item of add ?? []) {
        if (list.includes(item)) continue;
        list.push(item);
        note('targeting', 'add', `Add ${name} rule ${item}`);
      }
      if (list.length > TARGETING_MAX_RULES) throw invalid(`A site can have at most ${TARGETING_MAX_RULES} ${name} rules.`);
    }
    if (include.length || exclude.length) next.targeting = { include, exclude };
    else delete next.targeting;
  }

  /* ---------------------------------------------------------------- goals */
  let goals = [...(source.goals ?? [])];
  if (change.goals) {
    const g = change.goals;
    for (const id of g.remove ?? []) {
      const goal = goals.find(item => item.id === id);
      if (!goal) throw invalid(`There is no goal ${id} to remove.`);
      const using = (source.funnels ?? []).find(funnel => funnel.steps.some(step => step.goalId === id) && !(change.funnels?.remove ?? []).includes(funnel.id));
      if (using) throw invalid(`Funnel ${quote(using.name)} uses goal ${quote(goal.name)}. Remove the funnel in the same change first.`);
      goals = goals.filter(item => item.id !== id);
      note('goals', 'remove', `Remove goal ${quote(goal.name)} (${goalSummary(goal)})`);
    }
    for (const update of g.update ?? []) {
      const { id, ...input } = update;
      const current = goals.find(item => item.id === id);
      if (!current) throw invalid(`There is no goal ${id} to update.`);
      // Counting restarts when what the goal matches changes, so one goal never mixes two definitions.
      const unchanged = same(current, { kind: input.kind, match: input.match, by: 'by' in input ? input.by : undefined });
      const goal: Goal = { ...input, id, since: unchanged ? current.since : context.now };
      goals = goals.map(item => (item.id === id ? goal : item));
      note('goals', 'change', unchanged
        ? `Rename goal ${quote(current.name)} to ${quote(goal.name)}`
        : `Change goal ${quote(current.name)} from ${goalSummary(current)} to ${goalSummary(goal)}. Counting restarts now; earlier days are not recounted.`);
    }
    for (const input of g.add ?? []) {
      const twin = goals.find(item => same(item, { kind: input.kind, match: input.match, by: 'by' in input ? input.by : undefined }));
      if (twin) throw invalid(`Goal ${quote(twin.name)} already counts ${goalSummary(twin)}.`);
      const goal: Goal = { ...input, id: context.newId(), since: context.now };
      goals.push(goal);
      note('goals', 'add', `Add goal ${quote(goal.name)} (${goalSummary(goal)}). Counting starts now.`);
    }
    if (goals.length > MAX_GOALS) throw invalid(`A site can have at most ${MAX_GOALS} goals.`);
    if (goals.length) next.goals = goals;
    else delete next.goals;
  }

  /* -------------------------------------------------------------- funnels */
  if (change.funnels) {
    let funnels = [...(source.funnels ?? [])];
    for (const id of change.funnels.remove ?? []) {
      const funnel = funnels.find(item => item.id === id);
      if (!funnel) throw invalid(`There is no funnel ${id} to remove.`);
      funnels = funnels.filter(item => item.id !== id);
      note('funnels', 'remove', `Remove funnel ${quote(funnel.name)}`);
    }
    for (const input of change.funnels.add ?? []) {
      const steps = input.steps.map(reference => {
        const byId = goals.find(goal => goal.id === reference);
        if (byId) return byId;
        const byName = goals.filter(goal => goal.name.toLowerCase() === reference.toLowerCase());
        if (byName.length > 1) throw invalid(`More than one goal is named ${quote(reference)}. Use the goal id.`);
        if (!byName[0]) throw invalid(`A step names ${quote(reference)}, which is not a goal. Use a goal id or exact goal name.`);
        return byName[0];
      });
      if (new Set(steps.map(goal => goal.id)).size !== steps.length) throw invalid('A goal can be used once in a funnel.');
      const funnel: Funnel = { id: context.newId(), name: input.name, steps: steps.map(goal => ({ goalId: goal.id })), createdAt: context.now };
      funnels.push(funnel);
      note('funnels', 'add', `Add funnel ${quote(input.name)}: ${steps.map(goal => goal.name).join(', then ')}`);
    }
    if (funnels.length > MAX_FUNNELS) throw invalid(`A site can have at most ${MAX_FUNNELS} funnels.`);
    if (funnels.length) next.funnels = funnels;
    else delete next.funnels;
  }

  /* -------------------------------------------------------------- privacy */
  const currentPrivacy = projectPrivacy({ privacy: source.privacy });
  if (change.privacy) {
    const p = change.privacy;
    let policy: PrivacyPolicy = { ...currentPrivacy };
    if (p.preset !== undefined && p.preset !== currentPrivacy.preset) {
      if (PRESET_STRICTNESS[p.preset] < PRESET_STRICTNESS[currentPrivacy.preset]) throw weakening(`Moving the privacy preset from ${currentPrivacy.preset} to ${p.preset}`);
      policy = { ...policy, preset: p.preset };
      note('privacy', 'change', `Move the privacy preset from ${currentPrivacy.preset} to ${p.preset}`);
    }
    const added = (list: readonly string[], additions: readonly string[] | undefined, max: number, label: string, verb: string): string[] => {
      const out = [...list];
      for (const item of additions ?? []) {
        if (out.includes(item)) continue;
        out.push(item);
        note('privacy', 'add', `${verb} ${item}`);
      }
      if (out.length > max) throw invalid(`A site can have at most ${max} ${label}.`);
      return out;
    };
    policy = { ...policy, maskTextSelectors: added(policy.maskTextSelectors, p.addMaskTextSelectors, 50, 'text mask selectors', 'Mask text in') };
    policy = { ...policy, blockSelectors: added(policy.blockSelectors, p.addBlockSelectors, 50, 'block selectors', 'Block') };
    for (const item of p.removeUnmaskInputSelectors ?? []) {
      if (!policy.unmaskInputSelectors.includes(item)) throw invalid(`${item} is not in the unmasked inputs list.`);
      policy = { ...policy, unmaskInputSelectors: policy.unmaskInputSelectors.filter(existing => existing !== item) };
      note('privacy', 'remove', `Mask the values of ${item} again`);
    }
    if (p.captureQueryStrings !== undefined && p.captureQueryStrings !== currentPrivacy.captureQueryStrings) {
      if (p.captureQueryStrings) throw weakening('Keeping query strings in recorded paths');
      policy = { ...policy, captureQueryStrings: false };
      note('privacy', 'change', 'Stop keeping query strings in recorded paths');
    }
    // Defense in depth: whatever the steps above did, the result must not be looser.
    const reasons = privacyWeakening(currentPrivacy, policy);
    if (reasons.length) throw weakening(`A change that ${reasons.join(' and ')}`);
    if (!sameSet(policy.maskTextSelectors, currentPrivacy.maskTextSelectors) || !sameSet(policy.blockSelectors, currentPrivacy.blockSelectors) || !sameSet(policy.unmaskInputSelectors, currentPrivacy.unmaskInputSelectors)
      || policy.preset !== currentPrivacy.preset || policy.captureQueryStrings !== currentPrivacy.captureQueryStrings) next.privacy = policy;
  }

  /* ---------------------------------------------------------- path presets */
  if (change.pathPresets?.set?.length) {
    const presets = [...(source.pathPresets ?? [])];
    for (const wanted of change.pathPresets.set) {
      const at = presets.findIndex(item => item.match === wanted.match);
      if (at < 0) {
        presets.push({ match: wanted.match, preset: wanted.preset });
        note('pathPresets', 'add', `Use the ${wanted.preset} preset on ${wanted.match}`);
      } else if (presets[at]!.preset !== wanted.preset) {
        presets[at] = { match: wanted.match, preset: wanted.preset };
        note('pathPresets', 'change', `Change the preset on ${wanted.match} from ${source.pathPresets![at]!.preset} to ${wanted.preset}`);
      }
    }
    const reasons = pathPresetsWeakening(source.pathPresets, presets);
    if (reasons.length) throw weakening(`A change that ${reasons.join(' and ')}`);
    if (presets.length > MAX_PATH_PRESETS) throw invalid(`A site can have at most ${MAX_PATH_PRESETS} path presets.`);
    if (presets.length) next.pathPresets = presets;
    else delete next.pathPresets;
  }

  const areas = [...new Set(diff.map(entry => entry.area))];
  return { next, diff, areas };
}
