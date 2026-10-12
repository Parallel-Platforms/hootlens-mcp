/*
 * Per-path privacy presets. A site has one privacy policy (full, balanced or strict). A path preset makes capture
 * stricter on the pages it matches and can never loosen it, so the same pure function can run in the browser tracker,
 * the collector and the dashboard and always agree.
 *
 * - safe-form: for application and contact forms. Clicks and steps are recorded, but never what a visitor typed:
 *   the site's allowlist of unmasked inputs is ignored on these pages, whatever the site preset is, and query
 *   strings (which often carry prefilled personal data) are left out of the recorded path.
 * - balanced: at least the balanced preset on these pages.
 * - strict: the strict preset on these pages.
 *
 * Rules use the page targeting glob syntax and are tested against the page path. When several rules match, all of them
 * apply. Password, payment and one-time-code fields, private regions and URL fragments are never recorded under any policy.
 *
 * This module has no runtime dependencies (the tracker bundles it).
 */
import type { PrivacyPolicy, PrivacyPreset } from './index';
import { matchesTargetingRule, targetingRuleError } from './targeting';

export const PATH_PRESETS = ['safe-form', 'balanced', 'strict'] as const;
export type PathPresetName = (typeof PATH_PRESETS)[number];
/** Rules a site may hold. */
export const MAX_PATH_PRESETS = 20;

export interface PathPreset {
  /** A page path glob in the page targeting syntax, such as `/apply/**`. */
  match: string;
  preset: PathPresetName;
}

export const PATH_PRESET_INFO: Record<PathPresetName, { label: string; description: string }> = {
  'safe-form': {
    label: 'Safe form',
    description: 'Records clicks and steps, never what a visitor typed. The site\'s unmasked input allowlist and query strings are ignored on these pages.',
  },
  balanced: { label: 'Balanced', description: 'At least the balanced preset on these pages: emails, phone numbers and card numbers are redacted from text.' },
  strict: { label: 'Strict', description: 'The strict preset on these pages: all text is masked.' },
};

export const PRESET_STRICTNESS: Record<PrivacyPreset, number> = { full: 0, balanced: 1, strict: 2 };

/** Why a path preset rule cannot be used, or undefined when it is valid. */
export function pathPresetError(rule: unknown): string | undefined {
  if (!rule || typeof rule !== 'object') return 'A path preset must be an object.';
  const { match, preset } = rule as Record<string, unknown>;
  const problem = targetingRuleError(match);
  if (problem) return problem;
  if (!(PATH_PRESETS as readonly unknown[]).includes(preset)) return `A path preset must be one of ${PATH_PRESETS.join(', ')}.`;
  return undefined;
}

/**
 * The privacy policy in force on a page: the site policy, made stricter by every rule that matches any of `paths`
 * (pass the real pathname and the recorded path, so a path template cannot slip past a rule). Never looser than `policy`.
 * Returns `policy` itself when no rule matches.
 */
export function privacyForPath(policy: PrivacyPolicy, presets: readonly PathPreset[] | undefined, paths: string | readonly string[]): PrivacyPolicy {
  if (!presets?.length) return policy;
  const candidates = typeof paths === 'string' ? [paths] : paths;
  let effective = policy;
  for (const rule of presets) {
    if (pathPresetError(rule) || !candidates.some(path => matchesTargetingRule(rule.match, path))) continue;
    if (rule.preset === 'safe-form') {
      effective = { ...effective, unmaskInputSelectors: [], captureQueryStrings: false };
    } else if (PRESET_STRICTNESS[rule.preset] > PRESET_STRICTNESS[effective.preset]) {
      effective = { ...effective, preset: rule.preset };
    }
  }
  return effective;
}

/** True when a rule makes capture stricter than `policy` on the pages it matches. Rules that cannot change anything are still allowed. */
export const pathPresetTightens = (policy: PrivacyPolicy, rule: PathPreset): boolean =>
  rule.preset === 'safe-form' ? policy.unmaskInputSelectors.length > 0 || policy.captureQueryStrings : PRESET_STRICTNESS[rule.preset] > PRESET_STRICTNESS[policy.preset];
