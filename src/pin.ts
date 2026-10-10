import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/*
 * Project pinning for the local server. A person working in one project should not have to name it in every call.
 * The pin comes from, in order: the --project flag, HOOTLENS_PROJECT, or a .hootlens.json file found by walking up from
 * the working directory. Project IDs are public, so the file is safe to commit. A pin only sets a default: the API still
 * decides on every call whether the credential may reach the project.
 */

export const PROJECT_FILE = '.hootlens.json';
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export interface Pin { projectId: string; source: 'flag' | 'env' | 'file'; /** The file, for source file. */ file?: string }
export interface PinLookup { pin?: Pin; /** Something a person should know, for stderr. */ warnings: string[] }

export function findPin(options: { flag?: string | undefined; env: Record<string, string | undefined>; cwd: string; read?: (path: string) => string | undefined }): PinLookup {
  const warnings: string[] = [];
  const valid = (value: string | undefined) => value !== undefined && PROJECT_ID.test(value);
  if (options.flag !== undefined) {
    if (valid(options.flag)) return { pin: { projectId: options.flag, source: 'flag' }, warnings };
    warnings.push(`Ignoring --project "${options.flag.slice(0, 40)}": a project ID has letters, digits, "_" and "-" only.`);
  }
  const fromEnv = options.env.HOOTLENS_PROJECT?.trim();
  if (fromEnv) {
    if (valid(fromEnv)) return { pin: { projectId: fromEnv, source: 'env' }, warnings };
    warnings.push('Ignoring HOOTLENS_PROJECT: a project ID has letters, digits, "_" and "-" only.');
  }
  const read = options.read ?? ((path: string) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } });
  let directory = resolve(options.cwd);
  for (;;) {
    const file = join(directory, PROJECT_FILE);
    const text = read(file);
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text) as unknown;
        const projectId = typeof parsed === 'object' && parsed !== null ? (parsed as { projectId?: unknown }).projectId : undefined;
        if (typeof projectId === 'string' && valid(projectId)) return { pin: { projectId, source: 'file', file }, warnings };
        warnings.push(`Ignoring ${file}: it needs {"projectId": "..."} with a valid project ID.`);
      } catch {
        warnings.push(`Ignoring ${file}: it is not valid JSON.`);
      }
      return { warnings };
    }
    const parent = dirname(directory);
    if (parent === directory) return { warnings };
    directory = parent;
  }
}
