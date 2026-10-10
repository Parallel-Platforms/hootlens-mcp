/*
 * Agent onboarding: a coding agent asks for a Hoot Lens project for a site, and the site owner confirms with one link
 * sent to their email. The record holds only hashes of the two secrets (the link token the person receives and the poll
 * token the agent keeps), so neither can be read back from storage.
 */

/** How long the confirmation link works. */
export const CLAIM_TTL_MS = 24 * 3_600_000;
/** Claims per email address: a person cannot be mailed more often than this, whoever asks. */
export const CLAIM_EMAILS_PER_HOUR = 5;
export const CLAIM_EMAILS_PER_DAY = 10;
/** The confirmation link token (in the email) and the poll token (kept by the agent). Both are 256 random bits. */
export const CLAIM_TOKEN_PATTERN = /^hl_clm_[A-Za-z0-9_-]{43}$/;
export const CLAIM_POLL_PATTERN = /^hl_clp_[A-Za-z0-9_-]{43}$/;

export interface ClaimAgent {
  name: string;
  version?: string;
}

export interface ClaimRecord {
  id: string;
  /** The public project id the project will have once confirmed. */
  projectId: string;
  /** Lower-cased. */
  email: string;
  /** An exact origin, already normalised. */
  siteOrigin: string;
  projectName: string;
  agent?: ClaimAgent;
  /** SHA-256 of the link token. */
  hash: string;
  /** SHA-256 of the poll token. */
  pollHash: string;
  createdAt: number;
  expiresAt: number;
  confirmedAt?: number;
  confirmedBy?: string;
}

export type ClaimStatus = 'pending' | 'confirmed' | 'expired';

export const claimStatus = (claim: Pick<ClaimRecord, 'confirmedAt' | 'expiresAt'>, now: number): ClaimStatus =>
  claim.confirmedAt !== undefined ? 'confirmed' : claim.expiresAt <= now ? 'expired' : 'pending';

/** What the confirmation page shows before the person confirms. Nothing here is secret. */
export interface ClaimPreview {
  siteOrigin: string;
  projectName: string;
  agentName: string;
  email: string;
  expiresAt: number;
  status: ClaimStatus;
}

/** What the confirmation page receives once the project exists. */
export interface ClaimConfirmation {
  projectId: string;
  projectName: string;
  siteOrigin: string;
  agentName: string;
  /** True when this call created the project, false when the person had already confirmed. */
  created: boolean;
}
