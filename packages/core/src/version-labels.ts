/*
 * Readable names for heatmap versions.
 *
 * A heatmap cohort is identified by a release or a page version label such as `auto-12c8i3rbslq26+2`. Those are
 * internal ids: they say nothing to a person choosing between maps. This module names the cohorts of one page
 * group and device class by when they were live, for example "Current version (since Oct 5, 3:12 PM)" and
 * "Earlier version (Sep 29 to Oct 5)". The internal id stays available as `detail` for a tooltip or an info panel.
 *
 * Pure: the caller passes the cohorts and the change markers. A version began when the earliest change marker
 * for its label (an automatic "page changed" marker carries the page version, a logged one the release) says it
 * did. Without a marker the start is unknown and the label says when the version was last seen instead.
 */
import type { ChangeMarker } from './changes';
import type { HeatmapCohortSummary } from './index';

/** The page group of a cohort (`cohortGroup` in index.ts). Kept here so this module has no runtime imports and can be bundled alone. */
const cohortGroup = (cohort: Pick<HeatmapCohortSummary, 'path'> & { group?: string }): string => cohort.group ?? cohort.path;

export type VersionCohort = Pick<HeatmapCohortSummary, 'key' | 'path' | 'buildId' | 'revision' | 'deviceClass' | 'lastSeenAt'> &
  Partial<Pick<HeatmapCohortSummary, 'group' | 'pageVersion' | 'variant' | 'sessions'>>;
export type VersionMarker = Pick<ChangeMarker, 'at'> & Partial<Pick<ChangeMarker, 'pageGroup' | 'release'>>;

export interface VersionLabel {
  /** What the person reads, such as "Current version (since Oct 5, 3:12 PM)". */
  label: string;
  /** The label without its dates: "Current version", "Earlier version" or "Release". */
  kind: string;
  /** The internal ids, for a tooltip or detail line, never the label. */
  detail: string;
  /** The newest version of its page group and device class. */
  current: boolean;
  /** When the version began, when a change marker says so. */
  since?: number;
  /** When it was last seen. */
  until: number;
}

export interface VersionLabelOptions {
  /** Defaults to the reader's own, like the rest of the dashboard. Tests pass one. */
  locale?: string;
  timeZone?: string;
}

/** Ids the tracker or the collector made up. A release the customer named is shown as written. */
export const isGeneratedVersionId = (id: string | undefined): boolean => !id || /^auto-/i.test(id) || id === 'unversioned';

const dayText = (at: number, o: VersionLabelOptions) => new Date(at).toLocaleDateString(o.locale, { month: 'short', day: 'numeric', ...(o.timeZone ? { timeZone: o.timeZone } : {}) });
const dayTimeText = (at: number, o: VersionLabelOptions) =>
  new Date(at).toLocaleString(o.locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(o.timeZone ? { timeZone: o.timeZone } : {}) });

/** The internal ids of a cohort's version, for a tooltip. */
export function versionDetail(cohort: Pick<VersionCohort, 'buildId' | 'pageVersion' | 'revision' | 'variant'>): string {
  return [
    cohort.pageVersion ? `Page version id ${cohort.pageVersion}` : `Release id ${cohort.buildId || 'not supplied'}`,
    cohort.revision && cohort.revision !== 'page' ? `revision ${cohort.revision}` : '',
    cohort.variant ? `variant ${cohort.variant}` : '',
  ].filter(Boolean).join(', ');
}

function startOf(cohort: VersionCohort, markers: readonly VersionMarker[]): number | undefined {
  const id = cohort.pageVersion ?? cohort.buildId;
  const group = cohortGroup(cohort);
  let found: number | undefined;
  for (const marker of markers) {
    if (marker.release !== id || (marker.pageGroup !== undefined && marker.pageGroup !== group)) continue;
    if (found === undefined || marker.at < found) found = marker.at;
  }
  return found;
}

/**
 * Names for the cohorts of one page group and device class, newest first. Cohorts of other groups or devices in
 * `cohorts` are named within their own sets. The result is keyed by cohort key.
 */
export function labelVersions(cohorts: readonly VersionCohort[], markers: readonly VersionMarker[] = [], options: VersionLabelOptions = {}): Map<string, VersionLabel> {
  const sets = new Map<string, VersionCohort[]>();
  for (const cohort of cohorts) {
    const id = `${cohortGroup(cohort)}\u0000${cohort.deviceClass}`;
    sets.set(id, [...(sets.get(id) ?? []), cohort]);
  }
  const labels = new Map<string, VersionLabel>();
  for (const set of sets.values()) {
    set.sort((a, b) => b.lastSeenAt - a.lastSeenAt || (b.sessions ?? 0) - (a.sessions ?? 0) || a.key.localeCompare(b.key));
    set.forEach((cohort, index) => {
      const since = startOf(cohort, markers);
      const until = cohort.lastSeenAt;
      const current = index === 0;
      let kind: string;
      let label: string;
      if (cohort.pageVersion) {
        kind = current ? 'Current version' : 'Earlier version';
        if (current) label = since !== undefined ? `${kind} (since ${dayTimeText(since, options)})` : `${kind} (last seen ${dayText(until, options)})`;
        else if (since === undefined) label = `${kind} (until ${dayText(until, options)})`;
        else label = dayText(since, options) === dayText(until, options) ? `${kind} (${dayText(until, options)})` : `${kind} (${dayText(since, options)} to ${dayText(until, options)})`;
      } else {
        kind = 'Release';
        label = since !== undefined ? `${kind} from ${dayText(since, options)}` : `${kind} last seen ${dayText(until, options)}`;
      }
      labels.set(cohort.key, { label, kind, detail: versionDetail(cohort), current, ...(since !== undefined ? { since } : {}), until });
    });
  }
  return labels;
}

/** A name for one cohort with no siblings or markers to hand, such as a shared link: "Page version last seen Oct 5". */
export function standaloneVersionName(cohort: Pick<VersionCohort, 'buildId' | 'pageVersion' | 'lastSeenAt'>, options: VersionLabelOptions = {}): string {
  const seen = dayText(cohort.lastSeenAt, options);
  if (cohort.pageVersion) return `Page version last seen ${seen}`;
  return `Release last seen ${seen}`;
}

/** A release for a sentence, such as a recording's description: its name when the customer gave one, else nothing. */
export const namedRelease = (buildId: string | undefined): string | undefined => (isGeneratedVersionId(buildId) ? undefined : buildId);
