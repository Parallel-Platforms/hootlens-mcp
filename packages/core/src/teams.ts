/*
 * Teams and roles. One owner per project (Project.ownerId, unchanged), plus members who hold the editor or
 * viewer role. This module is the single place that says what each role may do, so the API, the dashboard and
 * the tests read the same table.
 */
import { z } from 'zod';
import type { Project, ProjectTokenScope, TokenScope } from './index';
import { PROJECT_TOKEN_SCOPES } from './index';

export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/** Roles a member can hold. The owner is the project's ownerId and is never stored as a member. */
export const MEMBER_ROLES = ['editor', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const memberRoleSchema = z.enum(MEMBER_ROLES);

/**
 * What a route can ask for.
 * - read, replay: look at data and open recordings.
 * - annotate: log and remove change markers.
 * - configure: analysis configuration that does not change what is captured (goals, page groups and grouping).
 * - tokens: manage one's own personal access tokens.
 * - member: be a member at all, which is what leaving a project needs.
 * - manage: everything else (settings, install, members, deleting recordings, other people's tokens).
 */
export type ProjectPermission = 'read' | 'replay' | 'annotate' | 'configure' | 'tokens' | 'member' | 'manage';

export const ROLE_PERMISSIONS: Record<ProjectRole, readonly ProjectPermission[]> = {
  viewer: ['read', 'replay', 'tokens', 'member'],
  editor: ['read', 'replay', 'annotate', 'configure', 'tokens', 'member'],
  owner: ['read', 'replay', 'annotate', 'configure', 'tokens', 'member', 'manage'],
};

export const roleAllows = (role: ProjectRole, permission: ProjectPermission): boolean => ROLE_PERMISSIONS[role].includes(permission);

/** Token scopes a role may put on a token it creates. */
export const TOKEN_SCOPES_FOR_ROLE: Record<ProjectRole, readonly ProjectTokenScope[]> = {
  viewer: ['read', 'replay'],
  editor: ['read', 'replay', 'annotate'],
  owner: ['read', 'replay', 'annotate'],
};

/**
 * What a token can do right now: its own scopes, limited to what its creator's current role allows.
 * A creator who is no longer a member (role undefined) leaves the token with nothing.
 */
export function effectiveTokenScopes(scopes: readonly TokenScope[], role: ProjectRole | undefined): ProjectTokenScope[] {
  if (!role) return [];
  // `triage` is not a project permission: it never survives here, whatever the role, and only the issues API reads it.
  return PROJECT_TOKEN_SCOPES.filter(scope => scopes.includes(scope) && roleAllows(role, scope));
}

export const INVITE_TTL_DAYS = 7;
export const MAX_MEMBERS = 50;
export const MAX_PENDING_INVITES = 20;
/** Audit events kept per project; older ones are dropped. */
export const MAX_MEMBERSHIP_EVENTS = 200;

/** A person who holds a role on a project they do not own. */
export interface MemberRecord {
  projectId: string;
  userId: string;
  /** The verified, lower-cased email the member signed in with when they accepted. */
  email: string;
  role: MemberRole;
  joinedAt: number;
  invitedBy: string;
  /** Written at most once an hour. */
  lastSeenAt?: number;
}

/** An invitation. The link token is shown once; only its hash is stored. */
export interface InviteRecord {
  id: string;
  projectId: string;
  /** Lower-cased. */
  email: string;
  role: MemberRole;
  hash: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  acceptedAt?: number;
  acceptedBy?: string;
}

export const MEMBERSHIP_EVENT_TYPES = ['invited', 'accepted', 'role_changed', 'removed', 'left', 'invite_revoked', 'app_connected', 'app_revoked'] as const;
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
  /** The connected app's name, for app_connected and app_revoked. The name is chosen by the app, not verified. */
  app?: string;
}

export const inviteInputSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)), role: memberRoleSchema });
export const memberUpdateSchema = z.object({ role: memberRoleSchema });
export const inviteTokenSchema = z.object({ token: z.string().regex(/^hl_inv_[A-Za-z0-9_-]{43}$/) });

/** What the invite page shows before someone accepts. */
export interface InvitePreview { projectName: string; role: MemberRole; email: string; expiresAt: number; alreadyMember: boolean }

/** A project as the caller sees it: its settings plus the caller's role. */
export type ProjectWithRole = Project & { role: ProjectRole };

/** One row of GET /v1/projects/:projectId/members. The owner's email is present only when the owner asks. */
export interface MemberListItem { userId: string; email?: string; role: ProjectRole; joinedAt: number; lastSeenAt?: number }
/** A pending invitation as the owner sees it. The link token is never listed. */
export interface InviteSummary { id: string; email: string; role: MemberRole; createdAt: number; expiresAt: number }
