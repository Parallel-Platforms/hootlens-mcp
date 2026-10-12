/*
 * Preview origins: addresses a project's owner allows to send test visits only. A pull request's preview deploy lives at
 * an address that changes with every pull request (deploy-preview-123--mysite.netlify.app), so the owner lists a pattern.
 *
 * A pattern is an https host in which `*` stands for part of ONE label and never matches a dot. No scheme other than
 * https, no port, no path. The part that names the owner is always fixed text: under a shared host such as netlify.app
 * the site label must keep real, specific text, and under any other domain the registrable domain (example.com,
 * example.co.uk) cannot contain a wildcard. The collector accepts a batch from a matching origin only when it is a
 * controlled-validation (test) visit; real visitor traffic still needs an exact entry in `origins`.
 */

/** Hosts where anyone can create a site. A pattern under one must pin down the site label. */
export const SHARED_PREVIEW_SUFFIXES: readonly string[] = [
  'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'onrender.com', 'github.io',
  'herokuapp.com', 'fly.dev', 'surge.sh', 'azurestaticapps.net', 'amplifyapp.com', 'ngrok.app', 'ngrok-free.app', 'trycloudflare.com',
];

/** Multi-part public suffixes a pattern may not wildcard in front of. Not the whole public suffix list: the common ones. */
const MULTI_PART_SUFFIXES: readonly string[] = [
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.in',
  'com.br', 'com.mx', 'com.ar', 'co.za', 'com.sg', 'com.cn', 'com.hk', 'co.kr', 'com.tr', 'com.tw', 'co.il', 'com.ua',
];

/** Words that say nothing about whose site it is, so they cannot be the part of a label that names the owner. */
const GENERIC_WORDS = new Set(['deploy', 'preview', 'branch', 'staging', 'review', 'pull', 'dev', 'test', 'main', 'git', 'app', 'site', 'web', 'www']);

export const PREVIEW_ORIGIN_LIMIT = 10;
const MAX_PATTERN_LENGTH = 120;
const MAX_WILDCARDS = 3;

export type PreviewPatternResult = { ok: true; pattern: string } | { ok: false; error: string };

const fail = (error: string): PreviewPatternResult => ({ ok: false, error });

const endsWithSuffix = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

/** True when the label keeps text that names the owner: an alphanumeric run of 4 or more characters that is not a generic word. */
function namesTheOwner(label: string): boolean {
  return label.split(/[^a-z0-9]+/).some(run => run.length >= 4 && !GENERIC_WORDS.has(run));
}

/** Checks one pattern and returns it in its stored form (lower case, no trailing slash), or says what is wrong. */
export function parsePreviewOrigin(raw: string): PreviewPatternResult {
  const text = raw.trim().toLowerCase().replace(/\/+$/, '');
  if (!text) return fail('Enter a preview address such as https://deploy-preview-*--mysite.netlify.app.');
  if (text.length > MAX_PATTERN_LENGTH) return fail(`Use ${MAX_PATTERN_LENGTH} characters or fewer.`);
  if (!text.startsWith('https://')) return fail('Preview addresses must start with https://.');
  const host = text.slice('https://'.length);
  if (/[^a-z0-9.*-]/.test(host)) return fail('Use only letters, numbers, hyphens, dots and * in the host. A port, path or login is not allowed.');
  if (host.includes('**')) return fail('Put text between wildcards.');
  const labels = host.split('.');
  if (labels.length < 2 || labels.some(label => label === '')) return fail('Enter a full host name such as mysite.netlify.app.');
  for (const label of labels) {
    if (label.length > 63 || !/^[a-z0-9*]([a-z0-9*-]*[a-z0-9*])?$/.test(label)) return fail(`"${label}" is not a valid host name part.`);
  }
  if (labels.every(label => /^[0-9*]+$/.test(label))) return fail('Use a host name, not an IP address.');
  if ((host.match(/\*/g) ?? []).length > MAX_WILDCARDS) return fail(`Use at most ${MAX_WILDCARDS} wildcards.`);

  const shared = SHARED_PREVIEW_SUFFIXES.find(suffix => endsWithSuffix(host, suffix));
  if (shared) {
    if (host === shared) return fail(`${shared} hosts many sites. Add your own site name in front of it.`);
    const rest = host.slice(0, -(shared.length + 1)).split('.');
    // The label next to the shared suffix names the site. It must keep text that is the owner's, not only wildcards or generic words.
    const siteLabel = rest[rest.length - 1]!;
    if (!namesTheOwner(siteLabel.replace(/\*/g, '-'))) {
      return fail(`${shared} hosts many sites, so the pattern must name yours. Keep your site's own name in the last part, such as deploy-preview-*--mysite.${shared}.`);
    }
    return { ok: true, pattern: `https://${host}` };
  }
  const multi = MULTI_PART_SUFFIXES.find(suffix => endsWithSuffix(host, suffix));
  if (multi && host === multi) return fail(`${multi} is a public suffix. Use a domain you own.`);
  const registrable = (multi ? multi.split('.').length : 1) + 1;
  if (labels.length < registrable) return fail('Use a domain you own, such as preview.example.com.');
  if (labels.slice(-registrable).some(label => label.includes('*'))) return fail('The registered domain (for example example.com) cannot contain a wildcard. Put * in front of it.');
  return { ok: true, pattern: `https://${host}` };
}

/** Validates a list the owner saves. Duplicates are dropped; the first problem is reported with the pattern it belongs to. */
export function parsePreviewOrigins(raw: readonly string[]): { ok: true; patterns: string[] } | { ok: false; error: string; value: string } {
  const patterns: string[] = [];
  for (const value of raw) {
    const parsed = parsePreviewOrigin(value);
    if (!parsed.ok) return { ok: false, error: parsed.error, value };
    if (!patterns.includes(parsed.pattern)) patterns.push(parsed.pattern);
  }
  if (patterns.length > PREVIEW_ORIGIN_LIMIT) return { ok: false, error: `Use at most ${PREVIEW_ORIGIN_LIMIT} preview addresses.`, value: '' };
  return { ok: true, patterns };
}

const compiled = new Map<string, RegExp>();
function regexFor(pattern: string): RegExp {
  let regex = compiled.get(pattern);
  if (!regex) {
    const host = pattern.slice('https://'.length);
    regex = new RegExp(`^${host.split('*').map(part => part.replace(/[.\\^$+?()[\]{}|-]/g, '\\$&')).join('[a-z0-9-]+')}$`);
    if (compiled.size > 500) compiled.clear();
    compiled.set(pattern, regex);
  }
  return regex;
}

/**
 * Whether a request's Origin header matches one of the stored patterns. The header must be exactly an https origin as a
 * browser writes it (no port, path or credentials), so look-alikes such as `https://deploy-preview-1--mysite.netlify.app.evil.test`
 * or `https://evil.test/deploy-preview-1--mysite.netlify.app` never match. Patterns are re-validated, so a stored value that
 * would no longer pass today's rules matches nothing.
 */
export function matchesPreviewOrigin(origin: string | undefined, patterns: readonly string[] | undefined): boolean {
  if (!origin || !patterns?.length || origin.length > 300) return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || url.origin !== origin) return false;
  const host = url.hostname;
  if (host.length > 253 || host.endsWith('.')) return false;
  return patterns.some(pattern => {
    const parsed = parsePreviewOrigin(pattern);
    return parsed.ok && parsed.pattern === pattern && regexFor(pattern).test(host);
  });
}
