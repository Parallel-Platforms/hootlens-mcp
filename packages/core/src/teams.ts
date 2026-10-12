/*
 * Teams and access. One owner per project (Project.ownerId, unchanged), plus members who each hold an explicit set of
 * permissions on that project. Roles are presets over those permissions: Viewer and Editor are exactly the sets they
 * always were and Custom is any other valid set. This module is the single place that says what a person may do, so the
 * API, the dashboard and the tests read the same table.
 */
import { z } from 'zod';
import type { Project, ProjectTokenScope } from './index';
import { PROJECT_TOKEN_SCOPES } from './index';

export const PROJECT_ROLES = ['owner', 'editor', 'viewer', 'custom'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/** Roles a member can hold. The owner is the project's ownerId and is never stored as a member. `custom` is a stored permission set. */
export const MEMBER_ROLES = ['editor', 'viewer', 'custom'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const memberRoleSchema = z.enum(MEMBER_ROLES);
/** The presets a person picks by name; any other set is Custom. */
export const ROLE_PRESETS = ['viewer', 'editor'] as const;
export type RolePreset = (typeof ROLE_PRESETS)[number];

/**
 * What a route can ask for.
 * - read: reports (traffic, findings, heatmaps, goals, funnels, errors, the weekly summary).
 * - replay: watch replays and read visit narratives, which carry the most recorded content.
 * - annotate: log and remove change markers, write notes and tags, make share links.
 * - configure: analysis configuration that does not change what is captured (goals, funnels, page groups, grouping, saved views, element names).
 * - tokens: manage one's own access keys and connect AI apps.
 * - member: be on the team at all (see one's own access, leave the site). Every member holds it.
 * - invite: see who is on the team, invite people and change or remove their access, within one's own permissions.
 * - manage: everything else (settings, install, deleting recordings, other people's keys). Owner only, never grantable.
 */
export type ProjectPermission = 'read' | 'replay' | 'annotate' | 'configure' | 'tokens' | 'member' | 'invite' | 'manage';

/** Permissions that can be granted to a member, in the order they are listed and stored. */
export const MEMBER_PERMISSIONS = ['read', 'replay', 'annotate', 'configure', 'tokens', 'member', 'invite'] as const;
export type MemberPermission = (typeof MEMBER_PERMISSIONS)[number];
export const ALL_PERMISSIONS: readonly ProjectPermission[] = [...MEMBER_PERMISSIONS, 'manage'];

export const ROLE_PERMISSIONS: Record<'owner' | RolePreset, readonly ProjectPermission[]> = {
  viewer: ['read', 'replay', 'tokens', 'member'],
  editor: ['read', 'replay', 'annotate', 'configure', 'tokens', 'member'],
  owner: ALL_PERMISSIONS,
};

/** Plain words for each grantable permission. `member` is always held, so it is described but never offered as a choice. */
export const PERMISSION_INFO: Record<MemberPermission, { label: string; summary: string }> = {
  read: { label: 'View reports', summary: 'Traffic, findings, heatmaps, goals, funnels, errors and the weekly summary.' },
  replay: { label: 'Watch replays', summary: 'Watch replays and read visit stories. Replays carry the most recorded content.' },
  annotate: { label: 'Log changes and notes', summary: 'Log changes, add notes and tags, and share links to recordings and heatmaps.' },
  configure: { label: 'Change site settings', summary: 'Goals, funnels, saved views, page groups and element names.' },
  tokens: { label: 'Create access keys', summary: 'Create access keys and connect AI apps, limited to what this person can do.' },
  member: { label: 'Be on the team', summary: 'See their own access and leave the site.' },
  invite: { label: 'Invite and manage people', summary: 'See the team, invite people and change their access, up to what they hold themselves.' },
};

/** A permission and the permissions it cannot work without. */
export const PERMISSION_REQUIRES: Partial<Record<MemberPermission, readonly MemberPermission[]>> = {
  replay: ['read'], annotate: ['read'], configure: ['read'],
};

/** What else goes when a permission is removed (everything that requires it, directly or not), in listing order. */
export function dependentsOf(permission: MemberPermission): MemberPermission[] {
  const out = new Set<MemberPermission>();
  const walk = (wanted: MemberPermission) => {
    for (const [candidate, needs] of Object.entries(PERMISSION_REQUIRES) as [MemberPermission, readonly MemberPermission[]][]) {
      if (needs.includes(wanted) && !out.has(candidate)) { out.add(candidate); walk(candidate); }
    }
  };
  walk(permission);
  return MEMBER_PERMISSIONS.filter(candidate => out.has(candidate));
}

/**
 * A permission set as it is stored and compared: grantable permissions only, each once, in the fixed order, always with
 * `member`. Returns a message for an invalid set: anything not grantable, a missing prerequisite, or a set with no way
 * in (it needs read or invite).
 */
export function normalizePermissions(input: readonly string[]): { ok: true; permissions: MemberPermission[] } | { ok: false; message: string } {
  const wanted = new Set<string>();
  for (const item of input) {
    if (item === 'manage') return { ok: false, message: 'Managing the site (billing, deleting the site, ownership) stays with the owner and cannot be granted.' };
    if (!(MEMBER_PERMISSIONS as readonly string[]).includes(item)) return { ok: false, message: `Unknown permission "${String(item).replace(/[^\w-]/g, '').slice(0, 40)}".` };
    wanted.add(item);
  }
  wanted.add('member');
  for (const permission of MEMBER_PERMISSIONS) {
    if (!wanted.has(permission)) continue;
    const missing = (PERMISSION_REQUIRES[permission] ?? []).filter(needed => !wanted.has(needed));
    if (missing.length) return { ok: false, message: `${PERMISSION_INFO[permission].label} needs ${missing.map(needed => PERMISSION_INFO[needed].label).join(' and ')}.` };
  }
  if (!wanted.has('read') && !wanted.has('invite')) return { ok: false, message: `Choose at least ${PERMISSION_INFO.read.label} or ${PERMISSION_INFO.invite.label}.` };
  return { ok: true, permissions: MEMBER_PERMISSIONS.filter(permission => wanted.has(permission)) };
}

/** A request body's permission list, validated and normalized. */
export const permissionSetSchema = z.array(z.string().max(40)).max(16).transform((value, context) => {
  const result = normalizePermissions(value);
  if (!result.ok) { context.addIssue({ code: 'custom', message: result.message }); return z.NEVER; }
  return result.permissions;
});

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(item => b.includes(item));

/** `viewer` or `editor` when the set is exactly that preset, otherwise `custom`. */
export function roleForPermissions(permissions: readonly string[]): MemberRole {
  if (sameSet(permissions, ROLE_PERMISSIONS.viewer)) return 'viewer';
  if (sameSet(permissions, ROLE_PERMISSIONS.editor)) return 'editor';
  return 'custom';
}

/** What the person holding access on a site shows: the role, and the explicit set when there is one. */
export interface AccessHolder { role: ProjectRole; permissions?: readonly string[] | undefined }

/**
 * The permissions a holder has. The owner has all of them. A member with a stored set has exactly that set (cleaned up,
 * so a bad stored value can only lose access, never gain it). A member without one derives it from the role, which is how
 * members made before custom access keep exactly the access they had. A custom role without a stored set has the bare minimum.
 */
export function permissionsOf(holder: AccessHolder | ProjectRole): readonly ProjectPermission[] {
  const role = typeof holder === 'string' ? holder : holder.role;
  if (role === 'owner') return ROLE_PERMISSIONS.owner;
  const stored = typeof holder === 'string' ? undefined : holder.permissions;
  if (stored) {
    const kept = new Set(stored);
    // Being on the team is implied for every member; anything else counts only with the permissions it needs.
    return MEMBER_PERMISSIONS.filter(permission => permission === 'member' || (kept.has(permission) && (PERMISSION_REQUIRES[permission] ?? []).every(needed => kept.has(needed))));
  }
  if (role === 'viewer' || role === 'editor') return ROLE_PERMISSIONS[role];
  return ['member'];
}

/** The one question every route and screen asks: may this person do that on this site? */
export const memberAllows = (holder: AccessHolder | ProjectRole | undefined, permission: ProjectPermission): boolean =>
  holder !== undefined && permissionsOf(holder).includes(permission);

/** True when `held` includes every permission in `wanted`. Used so nobody grants or changes what they do not hold. */
export const holdsAll = (held: readonly string[], wanted: readonly string[]): boolean => wanted.every(permission => held.includes(permission));

/** Token scopes a holder may put on a token it creates. */
export const tokenScopesFor = (holder: AccessHolder | ProjectRole | undefined): ProjectTokenScope[] =>
  PROJECT_TOKEN_SCOPES.filter(scope => memberAllows(holder, scope));

/**
 * What a token can do right now: its own scopes, limited to what its creator's current permissions allow.
 * A creator who is no longer a member (undefined), or who no longer holds the tokens permission, leaves the token with nothing.
 */
export function effectiveTokenScopes(scopes: readonly string[], holder: AccessHolder | ProjectRole | undefined): ProjectTokenScope[] {
  // Keys and connected apps are the tokens permission: without it, whatever a key was issued with, it does nothing.
  if (!holder || !memberAllows(holder, 'tokens')) return [];
  // `triage` is not a project permission: it never survives here, whatever the access, and only the issues API reads it.
  return PROJECT_TOKEN_SCOPES.filter(scope => scopes.includes(scope) && memberAllows(holder, scope));
}

/** Permissions in plain words, such as "View reports, Watch replays and Log changes and notes". `member` is left out: everyone has it. */
export function describePermissions(permissions: readonly string[]): string {
  const names = MEMBER_PERMISSIONS.filter(permission => permission !== 'member' && permissions.includes(permission)).map(permission => PERMISSION_INFO[permission].label);
  if (!names.length) return 'Team access only';
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The display name of a role. */
export const ROLE_LABELS: Record<ProjectRole, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer', custom: 'Custom' };

/**
 * The stored shape of a member's access for a chosen set: the role, and the set itself only when it is custom. A set
 * equal to a preset is stored as that preset, so it follows no hidden list.
 */
export function accessFromPermissions(permissions: readonly MemberPermission[]): { role: MemberRole; permissions?: MemberPermission[] } {
  const role = roleForPermissions(permissions);
  return role === 'custom' ? { role, permissions: [...permissions] } : { role };
}

/** The permission set a preset stands for. */
export const presetPermissions = (role: RolePreset): MemberPermission[] => [...ROLE_PERMISSIONS[role]] as MemberPermission[];

export const INVITE_TTL_DAYS = 7;
export const MAX_MEMBERS = 50;
export const MAX_PENDING_INVITES = 20;
/** Sites one invitation can cover. */
export const MAX_INVITE_SITES = 20;
/** Audit events kept per project; older ones are dropped. */
export const MAX_MEMBERSHIP_EVENTS = 200;

/** A person who holds access on a project they do not own. */
export interface MemberRecord {
  projectId: string;
  userId: string;
  /** The verified, lower-cased email the member signed in with when they accepted. */
  email: string;
  /** Viewer and Editor are presets; Custom means `permissions` holds the set. */
  role: MemberRole;
  /** The explicit set, stored only for a custom member. Absent means "derive from the role" (every member made before custom access). */
  permissions?: MemberPermission[];
  joinedAt: number;
  invitedBy: string;
  /** Written at most once an hour. */
  lastSeenAt?: number;
}

/** One site on an invitation and what it grants there. */
export interface InviteSite { siteId: string; permissions: MemberPermission[] }

/** An invitation. The link token is shown once; only its hash is stored. */
export interface InviteRecord {
  id: string;
  /** The first site of the invitation (the only one on an invitation made on a site's own route). */
  projectId: string;
  /** Every site the invitation covers, including `projectId`. Absent on invitations made before multi-site invitations. */
  projectIds?: string[];
  /** Lower-cased. */
  email: string;
  /** Display role for `projectId`. */
  role: MemberRole;
  /** What the invitation grants on each site. Absent on older invitations: `projectId` with the permissions of `role`. */
  sites?: InviteSite[];
  hash: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  acceptedAt?: number;
  acceptedBy?: string;
}

/** The sites an invitation grants, with the permission set for each (older invitations derive it from their role). */
export function inviteSitesOf(invite: Pick<InviteRecord, 'projectId' | 'role' | 'sites'>): InviteSite[] {
  if (invite.sites?.length) return invite.sites;
  return [{ siteId: invite.projectId, permissions: invite.role === 'custom' ? ['read', 'member'] : presetPermissions(invite.role) }];
}

export const MEMBERSHIP_EVENT_TYPES = ['invited', 'accepted', 'role_changed', 'removed', 'left', 'invite_revoked', 'app_connected', 'app_revoked', 'settings_changed'] as const;
export type MembershipEventType = (typeof MEMBERSHIP_EVENT_TYPES)[number];
export interface MembershipEvent {
  id: string;
  projectId: string;
  at: number;
  type: MembershipEventType;
  /** The user who did it. */
  actor: string;
  /** The user it was done to, when known. */
  subject?: string;
  /** The email of the member or invitee. */
  email?: string;
  role?: MemberRole;
  previousRole?: MemberRole;
  /** The permissions granted, invited with or left with (absent on events written before custom access). */
  permissions?: MemberPermission[];
  /** For role_changed and accepted over an existing member: the permissions held before. */
  previousPermissions?: MemberPermission[];
  /** The connected app's name, for app_connected and app_revoked. The name is chosen by the app, not verified. */
  app?: string;
  /** For settings_changed: one line per change that was applied, such as "Added goal Request a tour". Never visitor data. */
  changes?: string[];
  /** For settings_changed: how it was made. Settings changes through the API settings tools are made by an agent. */
  via?: 'agent';
}

/** A permission set on the wire: an explicit list, or a preset name. */
const permissionChoice = z.object({ role: memberRoleSchema.optional(), permissions: permissionSetSchema.optional() });
type PermissionChoice = z.infer<typeof permissionChoice>;

/**
 * Resolves a body's role and permissions to one normalized set. `{role: 'viewer'}` and `{role: 'editor'}` are the presets,
 * `{permissions}` is any valid set, and `{role: 'custom'}` needs `permissions`. A role and a set together must agree.
 */
export function resolveAccessChoice(choice: PermissionChoice): { ok: true; permissions: MemberPermission[] } | { ok: false; message: string } {
  if (choice.permissions) {
    if (choice.role && choice.role !== 'custom' && roleForPermissions(choice.permissions) !== choice.role) return { ok: false, message: `Those permissions are not the ${choice.role} preset. Use role "custom" or leave the role out.` };
    return { ok: true, permissions: choice.permissions };
  }
  if (choice.role === 'viewer' || choice.role === 'editor') return { ok: true, permissions: presetPermissions(choice.role) };
  return { ok: false, message: choice.role === 'custom' ? 'A custom role needs a permissions list.' : 'Choose a role or a permissions list.' };
}

const accessChoiceSchema = permissionChoice.refine(choice => choice.role !== undefined || choice.permissions !== undefined, 'Choose a role or a permissions list.');

/** Old shape `{ email, role }` stays valid; `permissions` makes it custom. */
export const inviteInputSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) }).and(accessChoiceSchema);
export const memberUpdateSchema = accessChoiceSchema;
export const inviteTokenSchema = z.object({ token: z.string().regex(/^hl_inv_[A-Za-z0-9_-]{43}$/) });

/** One site of a multi-site invitation request. */
export const inviteSiteInputSchema = z.object({ siteId: z.string().min(1).max(200), permissions: permissionSetSchema.optional(), role: z.enum(ROLE_PRESETS).optional() })
  .refine(site => (site.permissions === undefined) !== (site.role === undefined), 'Each site needs either a role (viewer or editor) or a permissions list.');
export const multiInviteInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  sites: z.array(inviteSiteInputSchema).min(1).max(MAX_INVITE_SITES),
});

/** The people a removal reaches: one site, a list, or (when omitted) every site the caller manages. */
export const memberRemoveSchema = z.object({ userId: z.string().min(1).max(200), siteIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional() });

/** One site as the invite page shows it. */
export interface InvitePreviewSite { projectId: string; projectName: string; role: MemberRole; permissions: MemberPermission[]; alreadyMember: boolean }
/**
 * What the invite page shows before someone accepts. `projectName` and `role` describe the first site, as they did before
 * multi-site invitations; `sites` lists every site that can still be joined, and `unavailable` counts those that cannot.
 */
export interface InvitePreview { projectName: string; role: MemberRole; email: string; expiresAt: number; alreadyMember: boolean; sites: InvitePreviewSite[]; unavailable: number }

/** The result of accepting, per site. */
export type InviteSiteOutcome = 'added' | 'updated' | 'unchanged' | 'skipped';
export interface InviteAcceptSite { projectId: string; projectName: string; outcome: InviteSiteOutcome; role?: MemberRole; permissions?: MemberPermission[]; reason?: string }

/** A project as the caller sees it: its settings plus the caller's role and permissions there. */
export type ProjectWithRole = Project & { role: ProjectRole; permissions: ProjectPermission[] };

/** One row of GET /v1/projects/:projectId/members. The owner's email is present only when the owner asks. */
export interface MemberListItem { userId: string; email?: string; role: ProjectRole; permissions: ProjectPermission[]; joinedAt: number; lastSeenAt?: number }
/** A pending invitation as the owner sees it. The link token is never listed. */
export interface InviteSummary { id: string; email: string; role: MemberRole; permissions: MemberPermission[]; sites: { siteId: string; name?: string; permissions: MemberPermission[] }[]; createdAt: number; expiresAt: number }
