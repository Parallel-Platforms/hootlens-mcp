/*
 * Hoot Lens for GitHub: the records and settings behind "turn findings into GitHub issues" and "report change impact
 * on merged pull requests". Pure types and validation shared by the API and the dashboard. Nothing here calls GitHub.
 */
import { z } from 'zod';

/** The kinds of finding that become issues. The first three are snag kinds; `goal-drop` is a conversion drop. */
export const GITHUB_FINDING_KINDS = ['pile-up', 'no-show', 'misfire', 'goal-drop'] as const;
export type GithubFindingKind = (typeof GITHUB_FINDING_KINDS)[number];
export const GITHUB_LABEL = 'hootlens';
/** Marks the OAuth state GitHub returns to the dashboard, so the dashboard knows the sign-in is for Hoot Lens for GitHub. */
export const GITHUB_STATE_PREFIX = 'hlgh_';
export const githubKindLabel = (kind: GithubFindingKind): string => `${GITHUB_LABEL}:${kind}`;

export const GITHUB_MAX_PER_WEEK = 10;
export const GITHUB_DEFAULT_PER_WEEK = 3;
/** A closed issue blocks a new one for the same finding for this long. */
export const GITHUB_REOPEN_GRACE_DAYS = 30;
/** An issue is closed with a comment after its finding has been absent this long. */
export const GITHUB_CLEAR_DAYS = 14;
/** `owner/name` as GitHub allows: owner up to 39 characters, repository up to 100. */
export const githubRepoSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/).refine(value => !value.endsWith('.git'));

export const githubSettingsSchema = z.object({
  issues: z.boolean(),
  maxPerWeek: z.number().int().min(1).max(GITHUB_MAX_PER_WEEK),
  /** Apply the `hootlens` and `hootlens:<kind>` labels to issues. */
  labels: z.boolean(),
  prComments: z.boolean(),
  /** Close an issue with a comment when its finding has cleared for GITHUB_CLEAR_DAYS days. */
  closeCleared: z.boolean(),
}).strict();
export type GithubSettings = z.infer<typeof githubSettingsSchema>;
export const defaultGithubSettings = (): GithubSettings => ({ issues: true, maxPerWeek: GITHUB_DEFAULT_PER_WEEK, labels: true, prComments: true, closeCleared: true });

export type GithubInactiveReason = 'uninstalled' | 'suspended' | 'repo-removed';

/** A project's link to one repository through one installation of the GitHub App. */
export interface GithubLink {
  projectId: string;
  installationId: number;
  repoId: number;
  /** `owner/name`. */
  repo: string;
  /** Whether the repository was private when last checked. Public repositories never get recording share links. */
  private: boolean;
  /** The person who linked it. Share links in issues are made as them, so they lapse if this person loses access. */
  linkedBy: string;
  linkedAt: number;
  settings: GithubSettings;
  state: 'active' | 'inactive';
  inactiveReason?: GithubInactiveReason;
  lastRunAt?: number;
  lastIssueAt?: number;
  /** The last problem a run met, in words. Cleared by the next clean run. */
  lastError?: string;
}

/** One issue Hoot Lens opened, kept so a finding is never filed twice. */
export interface GithubIssueRecord {
  fingerprint: string;
  kind: GithubFindingKind;
  number: number;
  state: 'open' | 'closed';
  openedAt: number;
  closedAt?: number;
  /** The first moment a run did not see the finding any more. Cleared when it returns. */
  clearSince?: number;
}

/** A merged pull request waiting for, or matched to, a change marker. */
export interface GithubPullRecord {
  number: number;
  mergeSha: string;
  mergedAt: number;
  state: 'pending' | 'matched' | 'unmatched';
  changeId?: string;
  matchedBy?: 'sha' | 'time';
  commentId?: number;
  /** The verdict text last posted, so an unchanged report is not written again. */
  postedSummary?: string;
  postedAt?: number;
}

export interface GithubInstallationRecord {
  id: number;
  account: string;
  state: 'active' | 'suspended' | 'deleted';
  updatedAt: number;
}

/** GET /v1/projects/:projectId/github */
export interface GithubStatus {
  /** False when this deployment has no GitHub App configured. */
  available: boolean;
  /** Where "Connect GitHub" goes: GitHub sign-in with a signed state. Absent when the caller may not connect. */
  connectUrl?: string;
  link?: Omit<GithubLink, 'linkedBy'> & { linkedByYou: boolean };
  /** Where to install the App on a GitHub account, when the person has not yet. */
  installNewUrl?: string;
  lastIssue?: { number: number; openedAt: number; kind: GithubFindingKind };
  openIssues: number;
  issuesThisWeek: number;
}

/** POST /v1/github/connect: the OAuth `code` and `state` GitHub sent back to the dashboard. */
export const githubConnectInputSchema = z.object({ code: z.string().min(1).max(200), state: z.string().min(10).max(1000) });
/** The installations of the GitHub App that the signed-in GitHub account can reach, with a short-lived grant that proves it. */
export interface GithubConnectResult {
  projectId: string;
  grant: string;
  installations: { id: number; account: string; repositorySelection: 'all' | 'selected' }[];
  /** Where to install the App when the list is empty or lacks the account. */
  installNewUrl?: string;
}
export interface GithubRepository { id: number; fullName: string; private: boolean }
/** POST /v1/projects/:projectId/github/link. `grant` is required unless the project is already linked through that installation. */
export const githubLinkInputSchema = z.object({
  installationId: z.number().int().positive(),
  repo: githubRepoSchema,
  grant: z.string().min(10).max(1000).optional(),
});
