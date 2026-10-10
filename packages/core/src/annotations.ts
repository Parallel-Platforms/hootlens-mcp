/*
 * Recording notes and tags. Both are written by the customer's own team, never captured from visitors: a note is
 * free text a person (or an agent holding a key with the annotate scope) typed, a tag is a short label from the
 * project's own vocabulary. They live with the recording and are deleted with it.
 */
import { z } from 'zod';

/** Longest note, in characters. */
export const NOTE_MAX_LENGTH = 1000;
/** Notes one recording can hold. */
export const MAX_NOTES_PER_RECORDING = 100;
/** Tags on one recording. */
export const MAX_TAGS_PER_RECORDING = 10;
/** Distinct tags a project's vocabulary can hold. */
export const MAX_TAG_VOCABULARY = 100;
export const TAG_MAX_LENGTH = 32;
/** The latest moment a note can point at, in milliseconds from the start of the recording (24 hours). */
export const NOTE_MAX_OFFSET_MS = 86_400_000;

/** Lower-case letters and digits in words joined by single hyphens, such as `checkout-bug`. */
export const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const tagSchema = z.string().trim().toLowerCase().min(1).max(TAG_MAX_LENGTH).regex(TAG_PATTERN);
export const tagsInputSchema = z.object({
  tags: z.array(tagSchema).max(MAX_TAGS_PER_RECORDING).transform(tags => [...new Set(tags)]),
});

const noteText = z.string().trim().min(1).max(NOTE_MAX_LENGTH);
const noteOffset = z.number().int().min(0).max(NOTE_MAX_OFFSET_MS);
export const noteInputSchema = z.object({ text: noteText, offsetMs: noteOffset.optional() });
/** An update changes the text, and optionally moves or (with null) clears the moment. */
export const noteUpdateSchema = z.object({ text: noteText, offsetMs: noteOffset.nullable().optional() });

/** A note as stored. */
export interface NoteRecord {
  id: string;
  projectId: string;
  recordingId: string;
  text: string;
  /** Milliseconds from the start of the recording, the position the replay seeks to. Absent for a note on the whole recording. */
  offsetMs?: number;
  /** The signed-in user, or for an access token the user who created it. Never sent to other readers. */
  authorId: string;
  /** A short name for readers: the part of the author's email before the @, or the access token's name. */
  author: string;
  /** True when an access token wrote the note. */
  viaToken?: boolean;
  createdAt: number;
  updatedAt?: number;
}

/** A note as a reader sees it. */
export interface NoteView {
  id: string;
  recordingId: string;
  text: string;
  offsetMs?: number;
  author: string;
  viaToken?: boolean;
  createdAt: number;
  updatedAt?: number;
  /** Whether the caller may edit and delete it: its author, or the project owner. */
  canEdit: boolean;
}

/** GET /v1/projects/:projectId/recordings/:id/notes */
export interface RecordingAnnotations { notes: NoteView[]; tags: string[] }
/** Notes and tags of one page view, as the narrative endpoints list them. Page views with neither are left out. */
export interface NarrativeAnnotation { recordingId: string; path: string; tags: string[]; notes: Pick<NoteView, 'id' | 'text' | 'offsetMs' | 'author' | 'createdAt'>[] }
