/*
 * What to tell someone installing Hoot Lens: the one tag, where it goes on each platform, the prompt that lets a coding
 * agent do it, and the rule for allowing a local development site. Shared by the dashboard, the API's install-snippet
 * route and through it the MCP tools, so a person and an agent get exactly the same text. Pure, no secrets: the project
 * ID is public. tests/compat/matrix builds the real apps with these exact code blocks.
 */
import type { ConsentMode } from './index';

export type InstallConsentSource = 'hootlens' | 'onetrust' | 'cookiebot' | 'gcm' | 'custom';
export interface InstallConsent {
  consent?: ConsentMode;
  consentSource?: InstallConsentSource;
  /** The category in the consent platform that explicitly covers visitor recording. */
  consentCategory?: string;
}

export const installConsentSource = (input: InstallConsent): InstallConsentSource | undefined =>
  input.consentSource ?? (input.consent === 'required' || input.consent === 'regional' ? 'hootlens' : undefined);

const consentAttributes = (input: InstallConsent): Array<[string, string]> => {
  const source = installConsentSource(input);
  return source && source !== 'custom' ? [
    ['data-consent-source', source],
    ...(source !== 'hootlens' ? [['data-consent-category', input.consentCategory || 'RECORDING_CATEGORY'] as [string, string]] : []),
  ] : [];
};

/** One script tag, no inline JavaScript. */
export const TRACKER_SCRIPT_ORIGIN = 'https://hootlens.com';
export const TRACKER_SCRIPT_URL = 'https://hootlens.com/t.js';
/** The collector the tracker uses when its tag has no data-endpoint. Keep in step with the tracker's DEFAULT_ENDPOINT. */
export const DEFAULT_COLLECTOR_ORIGIN = 'https://hootlens-api-368877148687.us-east1.run.app';

const attribute = (value: string) => value.replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`);

/** The install tag, with data-endpoint added when the workspace uses its own API. */
export function installTag(projectId: string, endpoint?: string, consent: InstallConsent = {}): string {
  const attrs = consentAttributes(consent).map(([key, value]) => ` ${key}="${attribute(value)}"`).join('');
  const tag = `<script async src="${TRACKER_SCRIPT_URL}" data-project="${attribute(projectId)}"${attrs}></script>`;
  return endpoint ? tag.replace('></script>', ` data-endpoint="${attribute(endpoint)}"></script>`) : tag;
}

/** The endpoint to put in the tag: none when the workspace uses the default collector. */
export const tagEndpointFor = (apiOrigin: string): string | undefined =>
  apiOrigin.replace(/\/$/, '') === DEFAULT_COLLECTOR_ORIGIN ? undefined : apiOrigin;

export type PlatformKey =
  | 'gtm' | 'wordpress' | 'shopify' | 'nextjs' | 'remix' | 'nuxt' | 'sveltekit' | 'astro' | 'angular' | 'gatsby' | 'vite'
  | 'webflow' | 'squarespace' | 'wix' | 'html';
export type PlatformGroup = 'One-click' | 'Frameworks' | 'Site builders' | 'Other';

export const PLATFORM_ORDER: PlatformKey[] = [
  'gtm', 'wordpress', 'shopify',
  'nextjs', 'remix', 'nuxt', 'sveltekit', 'astro', 'angular', 'gatsby', 'vite',
  'webflow', 'squarespace', 'wix',
  'html',
];

export const isPlatformKey = (value: unknown): value is PlatformKey =>
  typeof value === 'string' && (PLATFORM_ORDER as string[]).includes(value);

export interface GuideContext extends InstallConsent {
  projectId: string;
  /** The collector, when the tag needs a data-endpoint. Left out for the default collector. */
  endpoint?: string;
  /** Which placement to show for a platform that has more than one, such as the Next.js router. The first variant is the default. */
  variant?: string;
}

/** Platforms with two placements and the ids of each, the default first. */
export const PLATFORM_VARIANTS: Partial<Record<PlatformKey, { id: string; label: string }[]>> = {
  nextjs: [{ id: 'app', label: 'App Router' }, { id: 'pages', label: 'Pages Router' }],
};

export interface GuideData {
  id: PlatformKey;
  label: string;
  group: PlatformGroup;
  steps: string[];
  blocks: { file?: string; code: string }[];
  /** Where the code goes, in a few words. Used in prompts and the placement table. */
  where: string;
  /** The placements to choose between, when there are several, and the one shown. */
  variants?: { id: string; label: string }[];
  variant?: string;
}

const NEXT_APP = (ctx: GuideContext) =>
  `import Script from "next/script";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Script\n          src="${TRACKER_SCRIPT_URL}"\n          data-project="${attribute(ctx.projectId)}"${ctx.endpoint ? `\n          data-endpoint="${attribute(ctx.endpoint)}"` : ''}${consentAttributes(ctx).map(([key, value]) => `\n          ${key}="${attribute(value)}"`).join('')}\n          strategy="afterInteractive"\n        />\n      </body>\n    </html>\n  );\n}`;

const jsxScript = (ctx: GuideContext, indent = '') =>
  `${indent}<script async src="${TRACKER_SCRIPT_URL}" data-project="${attribute(ctx.projectId)}"${ctx.endpoint ? ` data-endpoint="${attribute(ctx.endpoint)}"` : ''}${consentAttributes(ctx).map(([key, value]) => ` ${key}="${attribute(value)}"`).join('')} />`;

const GTM_HTML = (ctx: GuideContext) =>
  `<script>\n(function () {\n  var s = document.createElement('script');\n  s.async = true;\n  s.src = '${TRACKER_SCRIPT_URL}';\n  s.setAttribute('data-project', '${ctx.projectId.replace(/['\\<]/g, '')}');${ctx.endpoint ? `\n  s.setAttribute('data-endpoint', '${ctx.endpoint.replace(/['\\<]/g, '')}');` : ''}${consentAttributes(ctx).map(([key, value]) => `\n  s.setAttribute('${key}', '${value.replace(/['\\<]/g, '')}');`).join('')}\n  document.head.appendChild(s);\n})();\n</script>`;

export function guideData(id: PlatformKey, ctx: GuideContext): GuideData {
  const tag = installTag(ctx.projectId, ctx.endpoint, ctx);
  const head = (file: string): GuideData['blocks'] => [{ file, code: tag }];
  switch (id) {
    case 'gtm':
      return {
        id, label: 'Google Tag Manager', group: 'One-click', where: 'a Custom HTML tag in the Tag Manager container, fired on All Pages',
        steps: [
          'In Tag Manager, open your container and choose Tags, then New.',
          'Choose Custom HTML and paste the code below.',
          'Set the trigger to All Pages. If you use consent mode, fire it after your consent trigger.',
          'Choose Submit, then Publish.',
        ],
        blocks: [{ code: GTM_HTML(ctx) }],
      };
    case 'wordpress':
      return {
        id, label: 'WordPress', group: 'One-click', where: 'the site head, through a header and footer scripts plugin',
        steps: [
          "In WordPress, open Plugins, then Add New, and install a header and footer scripts plugin.",
          "Open that plugin's settings and paste the tag into the header box, before </head>.",
          'Save. If you use a caching plugin, clear its cache so visitors get the new page.',
        ],
        blocks: [{ code: tag }],
      };
    case 'shopify':
      return {
        id, label: 'Shopify', group: 'One-click', where: 'layout/theme.liquid, just before </head> (never on checkout)',
        steps: [
          'In Shopify admin, open Online Store, then Themes. Next to your theme choose the three dots, then Edit code.',
          'Open layout/theme.liquid.',
          'Paste the tag just before </head> and save.',
          'Do not add it to checkout pages.',
        ],
        blocks: head('layout/theme.liquid'),
      };
    case 'nextjs': {
      const pages = ctx.variant === 'pages';
      return {
        id, label: 'Next.js', group: 'Frameworks', variants: PLATFORM_VARIANTS.nextjs!, variant: pages ? 'pages' : 'app',
        where: pages ? 'pages/_document.tsx (Pages Router), inside <Head>' : 'app/layout.tsx (App Router), inside <body>',
        steps: pages
          ? ['Open pages/_document.tsx.', 'Add the script inside <Head>.', 'Deploy.']
          : ['Open app/layout.tsx.', 'Add the Script component inside <body>, after {children}.', 'Deploy.'],
        blocks: pages
          ? [{ file: 'pages/_document.tsx', code: `import {Html, Head, Main, NextScript} from 'next/document';\n\nexport default function Document() {\n  return (\n    <Html lang="en">\n      <Head>\n${jsxScript(ctx, '        ')}\n      </Head>\n      <body>\n        <Main />\n        <NextScript />\n      </body>\n    </Html>\n  );\n}` }]
          : [{ file: 'app/layout.tsx', code: NEXT_APP(ctx) }],
      };
    }
    case 'remix':
      return {
        id, label: 'Remix and React Router', group: 'Frameworks', where: 'app/root.tsx, inside <head> of the Layout component',
        steps: ['Open app/root.tsx.', 'Paste the script inside <head> of the Layout component.', 'Deploy.'],
        blocks: [{ file: 'app/root.tsx', code: jsxScript(ctx) }],
      };
    case 'nuxt':
      return {
        id, label: 'Nuxt', group: 'Frameworks', where: 'nuxt.config.ts, under app.head.script',
        steps: ['Open nuxt.config.ts.', 'Add the script under app.head.', 'Deploy.'],
        blocks: [{
          file: 'nuxt.config.ts',
          code: `export default defineNuxtConfig({\n  app: {\n    head: {\n      script: [{src: '${TRACKER_SCRIPT_URL}', async: true, 'data-project': '${ctx.projectId.replace(/['\\]/g, '')}'${ctx.endpoint ? `, 'data-endpoint': '${ctx.endpoint.replace(/['\\]/g, '')}'` : ''}${consentAttributes(ctx).map(([key, value]) => `, '${key}': '${value.replace(/['\\<]/g, '')}'`).join('')}}],\n    },\n  },\n});`,
        }],
      };
    case 'sveltekit':
      return {
        id, label: 'SvelteKit', group: 'Frameworks', where: 'src/app.html, inside <head>',
        steps: ['Open src/app.html.', 'Paste the tag inside <head>.', 'Deploy.'],
        blocks: head('src/app.html'),
      };
    case 'astro':
      return {
        id, label: 'Astro', group: 'Frameworks', where: 'the layout, for example src/layouts/Layout.astro, inside <head> with is:inline',
        steps: [
          'Open your layout, for example src/layouts/Layout.astro.',
          'Paste the tag inside <head>. Keep is:inline, or Astro rewrites the script and drops its attributes.',
          'Deploy.',
        ],
        blocks: [{ file: 'src/layouts/Layout.astro', code: tag.replace('<script ', '<script is:inline ') }],
      };
    case 'angular':
      return {
        id, label: 'Angular', group: 'Frameworks', where: 'src/index.html, inside <head>',
        steps: ['Open src/index.html.', 'Paste the tag inside <head>.', 'Deploy.'],
        blocks: head('src/index.html'),
      };
    case 'gatsby':
      return {
        id, label: 'Gatsby', group: 'Frameworks', where: 'gatsby-ssr.js, through onRenderBody',
        steps: ['Open gatsby-ssr.js in your project root, or create it.', 'Add the script to the head from onRenderBody.', 'Deploy.'],
        blocks: [{
          file: 'gatsby-ssr.js',
          code: `import React from 'react';\n\nexport const onRenderBody = ({setHeadComponents}) => {\n  setHeadComponents([\n${jsxScript(ctx, '    ').replace('<script ', '<script key="hootlens" ')},\n  ]);\n};`,
        }],
      };
    case 'vite':
      return {
        id, label: 'Vite (React, Vue)', group: 'Frameworks', where: 'index.html in the project root, inside <head>',
        steps: ['Open index.html in your project root.', 'Paste the tag inside <head>. Client-side routes are picked up automatically.', 'Deploy.'],
        blocks: head('index.html'),
      };
    case 'webflow':
      return {
        id, label: 'Webflow', group: 'Site builders', where: 'Site settings, Custom code, Head code',
        steps: [
          'Open Site settings, then Custom code.',
          'Paste the tag into Head code and save.',
          'Publish the site. Some plans do not allow custom code.',
        ],
        blocks: [{ code: tag }],
      };
    case 'squarespace':
      return {
        id, label: 'Squarespace', group: 'Site builders', where: 'Settings, Advanced, Code Injection, Header',
        steps: [
          'Open Settings, then Advanced, then Code Injection.',
          'Paste the tag into Header and save.',
          'Check your published site. The editor preview does not run it, and some plans do not allow code injection.',
        ],
        blocks: [{ code: tag }],
      };
    case 'wix':
      return {
        id, label: 'Wix', group: 'Site builders', where: 'Settings, Custom code, in the head of all pages',
        steps: [
          'Open Settings, then Custom code, then Add custom code.',
          'Paste the tag, place it in the head, and apply it to all pages.',
          'Publish, then check the published site. The editor does not run it, and some plans do not allow custom code.',
        ],
        blocks: [{ code: tag }],
      };
    case 'html':
      return {
        id, label: 'Any other site', group: 'Other', where: 'the <head> of every page you want to record',
        steps: ['Paste the tag inside the <head> of every page you want to record.', 'Publish the change.'],
        blocks: [{ code: `<head>\n  …\n  ${tag}\n</head>` }],
      };
  }
}

/** The page address the verification step opens: the site itself, or the local server for a local project. */
export interface PromptInput extends GuideContext {
  host: string;
  platform: PlatformKey;
}

/** Instructions describe the site's current policy. A missing policy never implies permission to record. */
export function installConsentInstructions(input: InstallConsent): string[] {
  const source = installConsentSource(input);
  const mode = input.consent ?? 'required';
  return [
    input.consent === undefined
      ? 'Confirm the site’s consent policy with its owner. Until it is known, require an explicit visitor recording choice. A loaded tag is not permission to record.'
      : mode === 'implied'
      ? 'This site permits recording on load, subject to its page rules, Global Privacy Control, and Do Not Track. Keep a visitor opt-out in the site’s privacy controls.'
      : mode === 'regional'
      ? 'This site requires consent in its configured regions. Keep that policy: a loaded tag can wait for the visitor’s choice before recording.'
      : 'This site requires visitor consent. A loaded tag is not permission to record.',
    source === 'hootlens'
      ? 'The tag includes data-consent-source="hootlens": visitors choose “Record my visit” and can withdraw with “Stop recording”. The control stays available after approval and on later visits. No consent code is needed. Only the visitor chooses.'
      : source && source !== 'custom'
      ? `The tag follows ${source === 'gcm' ? 'Google Consent Mode' : source === 'cookiebot' ? 'Cookiebot' : 'OneTrust'}. ${!input.consentCategory || input.consentCategory === 'RECORDING_CATEGORY' ? 'Replace RECORDING_CATEGORY with your recording category ID before publishing. ' : ''}Map that category to an explicit visitor choice that covers replay, including withdrawal. Do not assume analytics consent covers recording.`
      : 'Connect the visitor’s recording choice to (window.hootlens = window.hootlens || []).push([\'consent\', true]); and their refusal or withdrawal to the same command with false. Run these only from real visitor choices, never on page load.',
    'Never grant consent automatically to pass a check, change the project’s consent policy, or bypass Global Privacy Control or Do Not Track.',
  ];
}

export function installVerification(input: InstallConsent): string[] {
  const requiresChoice = input.consent !== 'implied';
  return [
    `Publish, open a permitted public page, and run \`Hootlens.status()\`. ${requiresChoice ? 'Before a new visitor chooses recording, expect `waiting-consent` wherever consent is required. Use the visible recording choice, then expect' : 'For a visitor who has not opted out, expect'} \`state: 'recording'\` when no privacy signal blocks it.`,
    'Test refusal and withdrawal: recording must stop. Never override privacy signals or erase someone else’s choice to pass a check.',
    'For another state, read `reason` or use `?hootlens=debug`. Check Pages to record for `not-targeted` and allowed origins for `collector-rejected`. Ask the owner before allowing localhost.',
    'In Hoot Lens Installation, confirm a recording actually arrived. Open its summary and replay before reporting completion.',
  ];
}

/** The tag alone, shown on every platform as the one line to copy. */
export const tagLine = (ctx: GuideContext): string => installTag(ctx.projectId, ctx.endpoint, ctx);

/**
 * A short, exact prompt to paste into a coding agent. It carries the public project ID and the platform's file and
 * snippet. It never carries a token: nothing here needs one.
 */
export function agentPrompt(input: PromptInput): string {
  const guide = guideData(input.platform, input);
  const alternative = guide.variants?.find(variant => variant.id !== guide.variant);
  const other = alternative ? { label: alternative.label, where: guideData(input.platform, { ...input, variant: alternative.id }).where } : undefined;
  const selected = guide.variants?.find(variant => variant.id === guide.variant)?.label;
  const codeBlocks = guide.blocks.map(block => `${block.file ? `${block.file}:\n` : ''}${block.code}`).join('\n\n');
  return [
    `Install Hoot Lens on this site (${input.host}).`,
    '',
    `Site ID: ${input.projectId} (the data-project value; public, safe to commit)`,
    `Platform: ${guide.label}`,
    '',
    `1. Add the tag in ${guide.where}. Add it once, so it loads on every public page:`,
    '',
    codeBlocks,
    '',
    ...(other ? [`   (This is the ${selected} setup. For the ${other.label}, use ${other.where} instead.)`] : []),
    '2. Do not add it to signed-in, admin, account, checkout or other private pages, and do not wrap it in code that reads user data.',
    '3. Do not create or paste any API token or secret. The site ID above is the only value needed.',
    '4. Connect the visitor’s recording choice:',
    ...installConsentInstructions(input),
    '5. Verify the real outcome:',
    ...installVerification(input),
    '',
    'Edit only with authorized file or CMS access. A Hoot Lens connection cannot edit this site; otherwise hand these steps to its developer.',
    'Report files changed, consent tests, and whether a recording arrived. A tag alone does not prove installation.',
  ].join('\n');
}

/** The same install as Markdown, for a README, a ticket or an agent that reads a document. */
export function installMarkdown(input: PromptInput): string {
  const guide = guideData(input.platform, input);
  const alternative = guide.variants?.find(variant => variant.id !== guide.variant);
  const alternativeNote = alternative ? [`This is the ${guide.variants?.find(variant => variant.id === guide.variant)?.label} setup. For the ${alternative.label}, use ${guideData(input.platform, { ...input, variant: alternative.id }).where} instead.`, ''] : [];
  return [
    `# Install Hoot Lens on ${input.host}`,
    '',
    'Hoot Lens needs one tag on every page you want to record. It loads without blocking the page. The site ID is public.',
    '',
    `Site ID: \`${input.projectId}\``,
    '',
    '## 1. Add the tag',
    '',
    '```html',
    tagLine(input),
    '```',
    '',
    `## 2. Put it in the right place (${guide.label})`,
    '',
    ...guide.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    ...guide.blocks.flatMap(block => [block.file ? `\`${block.file}\`:` : 'Code:', '', '```', block.code, '```', '']),
    ...alternativeNote,
    '## 3. Connect the visitor’s recording choice',
    '',
    ...installConsentInstructions(input).map(line => `- ${line}`),
    '',
    '## 4. Check it',
    '',
    ...installVerification(input).map(line => `- ${line}`),
    '',
    'Keep the tag off signed-in and private pages. Passwords, payment fields, one-time codes and anything marked `data-hoot-private` are never recorded.',
    '',
  ].join('\n');
}

/** Where the tag goes for each platform, as a table for documents and the llms.txt index. */
export const placementTable = (): { platform: string; where: string }[] =>
  PLATFORM_ORDER.map(id => { const guide = guideData(id, { projectId: 'PROJECT_ID' }); return { platform: guide.label, where: guide.where }; });

/** Ports the common dev servers use, to prefill "Allow localhost". */
const DEV_PORTS: Partial<Record<PlatformKey, number>> = { nextjs: 3000, nuxt: 3000, remix: 5173, vite: 5173, sveltekit: 5173, astro: 4321, angular: 4200, gatsby: 8000 };
export const defaultDevPort = (platform: PlatformKey): number => DEV_PORTS[platform] ?? 3000;

/** The only hosts a project may allow over plain http: this computer. */
export const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1'] as const;
export const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname) && url.username === '' && url.password === '';
  } catch { return false; }
};

/**
 * "3000", "localhost:3000" or "http://127.0.0.1:5173" become an exact loopback origin. A port is required, and any other
 * host is refused, so this can never allow a real site.
 */
export function parseLoopbackOrigin(raw: string): { ok: true; origin: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'Enter the port your local site runs on, such as 3000.' };
  const withHost = /^\d+$/.test(text) ? `localhost:${text}` : text;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(withHost) ? withHost : `http://${withHost}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return { ok: false, error: 'That does not look like a local address. Try localhost:3000.' }; }
  if (url.protocol !== 'http:') return { ok: false, error: 'Local sites use http://.' };
  if (!(LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname) || url.username || url.password) return { ok: false, error: 'Only localhost and 127.0.0.1 can be allowed this way.' };
  const port = Number(url.port);
  if (!url.port || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Include the port, such as localhost:3000.' };
  if (url.pathname !== '/' || url.search || url.hash) return { ok: false, error: 'Use only the host and port, such as localhost:3000.' };
  return { ok: true, origin: url.origin };
}

/** A name for a new site from its host: the host without a leading www. Editable by the person. */
export const siteNameFromHost = (host: string): string => host.replace(/^www\./i, '').slice(0, 80);
