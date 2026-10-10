/*
 * Where visits come from. Zod-free, so the tracker bundle, the collector and the dashboard share one table.
 *
 * The tracker sends only coarse, closed-vocabulary facts about a landing: the NAME of an ad network whose click
 * ID parameter was present on the URL (never the ID), the NAME of an in-app browser (never the user agent), and
 * the campaign parameters it already sent. The collector adds the visitor's country from the request address
 * (never stored) and derives a readable default channel with classifyChannel. Every table below is data: add a
 * row to extend it, and docs/FAQ.md lists the same rules in words.
 */

/* ---------------------------------------------------------------- ad click IDs */

export const AD_NETWORKS = ['google_ads', 'meta_click', 'microsoft_ads', 'tiktok_ads', 'linkedin_ads', 'x_ads', 'pinterest_ads', 'snapchat_ads', 'yandex_ads'] as const;
export type AdNetwork = (typeof AD_NETWORKS)[number];

/**
 * Click ID query parameters and the network each one names. Names are compared case-insensitively. Only that the
 * parameter was present is read: the value is never copied, hashed or sent, and the tracker removes these
 * parameters from any recorded page path or URL.
 *
 * Ambiguity: `fbclid` is added to links on Facebook and Instagram whether the link is an ad or an ordinary share,
 * so it is recorded as `meta_click` and only counts as paid social when utm_medium says paid. `epik` and
 * `li_fat_id` can also appear on non-ad traffic from their networks. `gclid` marks Google Ads clicks of every
 * kind (search, display, video); without UTMs they are treated as paid search.
 */
export const AD_CLICK_PARAMS: Readonly<Record<string, AdNetwork>> = {
  gclid: 'google_ads', gbraid: 'google_ads', wbraid: 'google_ads', dclid: 'google_ads',
  fbclid: 'meta_click',
  msclkid: 'microsoft_ads',
  ttclid: 'tiktok_ads',
  li_fat_id: 'linkedin_ads',
  twclid: 'x_ads',
  epik: 'pinterest_ads',
  sccid: 'snapchat_ads',
  yclid: 'yandex_ads',
};
const AD_CLICK_MAP: ReadonlyMap<string, AdNetwork> = new Map(Object.entries(AD_CLICK_PARAMS));

const paramName = (pair: string): string => {
  const raw = pair.split('=', 1)[0] ?? '';
  try { return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase(); } catch { return raw.toLowerCase(); }
};

/** The ad network named by a click ID parameter in a query string, or undefined. Reads names only, never values. */
export function detectAdNetwork(search: string): AdNetwork | undefined {
  if (!search) return undefined;
  const query = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of query.split('&')) {
    const network = AD_CLICK_MAP.get(paramName(pair));
    if (network) return network;
  }
  return undefined;
}

/** A query string without click ID parameters (with its `?`), or '' when nothing is left. Other parameters keep their order and encoding. */
export function stripAdClickParams(search: string): string {
  if (!search) return search;
  const query = search.startsWith('?') ? search.slice(1) : search;
  const kept = query.split('&').filter(pair => pair !== '' && !AD_CLICK_MAP.has(paramName(pair)));
  return kept.length ? `?${kept.join('&')}` : '';
}

/** A URL or path with click ID parameters removed from its query. The fragment is left as it was. */
export function stripAdClickParamsFromUrl(url: string): string {
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  const query = base.indexOf('?');
  if (query < 0) return url;
  const search = base.slice(query);
  const cleaned = stripAdClickParams(search);
  return cleaned === search ? url : base.slice(0, query) + cleaned + (hash < 0 ? '' : url.slice(hash));
}

export const AD_NETWORK_LABELS: Readonly<Record<AdNetwork, string>> = {
  google_ads: 'Google Ads click', meta_click: 'Meta click (ad or share)', microsoft_ads: 'Microsoft Ads click',
  tiktok_ads: 'TikTok Ads click', linkedin_ads: 'LinkedIn Ads click', x_ads: 'X Ads click',
  pinterest_ads: 'Pinterest click', snapchat_ads: 'Snapchat Ads click', yandex_ads: 'Yandex Ads click',
};

/* ---------------------------------------------------------------- in-app browsers */

export const IN_APPS = ['facebook', 'instagram', 'messenger', 'tiktok', 'linkedin', 'snapchat', 'pinterest', 'x', 'wechat', 'line'] as const;
export type InApp = (typeof IN_APPS)[number];

/** First match wins: Instagram and Messenger user agents can also carry Facebook markers. */
const IN_APP_PATTERNS: readonly (readonly [InApp, RegExp])[] = [
  ['instagram', /\bInstagram\b/],
  ['messenger', /FBAN\/Messenger|FB_IAB\/MESSENGER|\bMessenger(?:Lite)?ForiOS\b|\bOrca-Android\b/i],
  ['facebook', /\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b|\bFB4A\b/],
  ['tiktok', /musical_ly|BytedanceWebview|\bTikTok\b|\btrill_\d/i],
  ['linkedin', /\bLinkedInApp\b/],
  ['snapchat', /\bSnapchat\//],
  ['pinterest', /\bPinterest\//],
  ['x', /\bTwitter(?:Android|\/|\s+for\s)/i],
  ['wechat', /\bMicroMessenger\//],
  ['line', /\bLine\/\d/],
];

export const IN_APP_LABELS: Readonly<Record<InApp, string>> = {
  facebook: 'Facebook app', instagram: 'Instagram app', messenger: 'Messenger app', tiktok: 'TikTok app', linkedin: 'LinkedIn app',
  snapchat: 'Snapchat app', pinterest: 'Pinterest app', x: 'X app', wechat: 'WeChat app', line: 'Line app',
};

/**
 * The app whose in-app browser is showing the page, from the user agent, or undefined for an ordinary browser.
 * Only the app name leaves the browser. Some apps (X on iOS and Android, for example) open links in the system
 * browser or a custom tab with no marker, and those visits cannot be told apart.
 */
export function detectInApp(userAgent: string | undefined): InApp | undefined {
  if (!userAgent) return undefined;
  const agent = userAgent.slice(0, 1000);
  for (const [app, pattern] of IN_APP_PATTERNS) if (pattern.test(agent)) return app;
  return undefined;
}

/* ---------------------------------------------------------------- channels */

export const CHANNELS = ['direct', 'organic_search', 'paid_search', 'organic_social', 'paid_social', 'email', 'ai_assistant', 'referral', 'display', 'affiliate', 'video', 'sms', 'other_campaign'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABELS: Readonly<Record<Channel, string>> = {
  direct: 'Direct', organic_search: 'Organic search', paid_search: 'Paid search', organic_social: 'Organic social', paid_social: 'Paid social',
  email: 'Email', ai_assistant: 'AI assistant', referral: 'Referral', display: 'Display', affiliate: 'Affiliate', video: 'Video', sms: 'SMS',
  other_campaign: 'Other campaign',
};
export const isChannel = (value: string): value is Channel => (CHANNELS as readonly string[]).includes(value);
export const isAdNetwork = (value: string): value is AdNetwork => (AD_NETWORKS as readonly string[]).includes(value);
export const isInApp = (value: string): value is InApp => (IN_APPS as readonly string[]).includes(value);

/** What the channel is derived from. Every field is something the collector already stores. */
export interface ChannelInput {
  /** Referrer origin such as `https://www.google.com`. */
  referrer?: string;
  utm?: { source?: string; medium?: string; campaign?: string; id?: string };
  adNetwork?: AdNetwork;
  inApp?: InApp;
}

type SourceGroup = 'search' | 'social' | 'video' | 'email' | 'ai';
/** Names a utm_source can take, compared after lower-casing, dropping a leading `www.` and a trailing top-level domain. */
export const SOURCE_GROUPS: Readonly<Record<SourceGroup, readonly string[]>> = {
  search: ['google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex', 'ecosia', 'brave', 'startpage', 'qwant', 'naver', 'seznam', 'kagi', 'ask', 'aol', 'sogou', 'msn'],
  social: ['facebook', 'fb', 'instagram', 'ig', 'messenger', 'meta', 'twitter', 'x', 'linkedin', 'lnkd', 'pinterest', 'tiktok', 'snapchat', 'reddit', 'threads', 'bluesky', 'bsky', 'mastodon', 'whatsapp', 'telegram', 'wechat', 'line', 'vk', 'weibo', 'tumblr', 'quora', 'discord'],
  video: ['youtube', 'youtu', 'vimeo', 'twitch', 'dailymotion'],
  email: ['email', 'e-mail', 'newsletter', 'mail', 'mailchimp', 'klaviyo', 'sendgrid', 'constantcontact', 'campaignmonitor'],
  ai: ['chatgpt', 'openai', 'perplexity', 'claude', 'gemini', 'copilot', 'bard', 'poe', 'phind', 'grok', 'deepseek', 'mistral', 'meta.ai', 'you.com'],
};

/** Media that mark paid traffic (GA4's rule): anything with `cp` in it (cpc, cpm, cpv), ppc, retargeting and paid*. */
export const PAID_MEDIUM = /^(?:.*cp.*|ppc|retargeting|paid.*)$/;

const normalizeSource = (source: string): string[] => {
  const value = source.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  if (!value) return [];
  const names = new Set([value]);
  const dot = value.indexOf('.');
  if (dot > 0) names.add(value.slice(0, dot));
  return [...names];
};
const inGroup = (source: string | undefined, group: SourceGroup): boolean => Boolean(source) && normalizeSource(source!).some(name => SOURCE_GROUPS[group].includes(name));

/**
 * Campaign rules, top to bottom, first match wins. A row matches when the medium matches `medium` (if given), the
 * source is in the `source` group (if given) and the medium's paid status equals `paid` (if given).
 */
interface CampaignRule { channel: Channel; medium?: RegExp; source?: SourceGroup; paid?: boolean }
export const CAMPAIGN_RULES: readonly CampaignRule[] = [
  { channel: 'paid_social', source: 'social', paid: true },
  { channel: 'paid_social', medium: /^(?:paid[-_ ]?social|social[-_ ]?paid|paidsocial)$/ },
  { channel: 'paid_search', source: 'search', paid: true },
  { channel: 'paid_search', medium: /^(?:paid[-_ ]?search|paidsearch|sem)$/ },
  { channel: 'video', source: 'video' },
  { channel: 'video', medium: /^(?:video|cpv)$/ },
  { channel: 'display', medium: /^(?:display|banner|expandable|interstitial|cpm)$/ },
  { channel: 'affiliate', medium: /^affiliates?$/ },
  { channel: 'email', medium: /^(?:e-?mail|e_mail|newsletter)$/ },
  { channel: 'sms', medium: /^(?:sms|text|txt)$/ },
  { channel: 'organic_social', medium: /^(?:social|social[-_ ]?network|social[-_ ]?media|sm|organic[-_ ]?social|social[-_ ]?organic)$/ },
  { channel: 'organic_social', source: 'social', paid: false },
  { channel: 'organic_search', medium: /^organic$/ },
  { channel: 'organic_search', source: 'search', paid: false },
  { channel: 'email', source: 'email', paid: false },
  { channel: 'referral', medium: /^(?:referral|app|link)$/ },
];

/** Channel of an ad click ID with no campaign tags. `meta_click` is decided by the medium: see classifyChannel. */
export const AD_NETWORK_CHANNELS: Readonly<Record<AdNetwork, Channel | 'by_medium'>> = {
  google_ads: 'paid_search', microsoft_ads: 'paid_search', yandex_ads: 'paid_search',
  meta_click: 'by_medium',
  tiktok_ads: 'paid_social', linkedin_ads: 'paid_social', x_ads: 'paid_social', pinterest_ads: 'paid_social', snapchat_ads: 'paid_social',
};

/** Referrer rules, top to bottom, first match wins. `hosts` match the host or any subdomain; `pattern` matches the whole host. */
interface ReferrerRule { channel: Channel; hosts?: readonly string[]; pattern?: RegExp }
export const REFERRER_RULES: readonly ReferrerRule[] = [
  { channel: 'ai_assistant', hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'bard.google.com', 'copilot.microsoft.com', 'poe.com', 'phind.com', 'you.com', 'grok.com', 'deepseek.com', 'chat.mistral.ai', 'meta.ai'] },
  { channel: 'email', hosts: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me', 'mail.aol.com', 'mail.zoho.com'] },
  { channel: 'organic_search', pattern: /^(?:www\.|m\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/ },
  { channel: 'organic_search', hosts: ['bing.com', 'duckduckgo.com', 'yahoo.com', 'baidu.com', 'yandex.com', 'yandex.ru', 'ecosia.org', 'search.brave.com', 'startpage.com', 'qwant.com', 'kagi.com', 'ask.com', 'search.aol.com', 'sogou.com', 'seznam.cz', 'search.naver.com'] },
  { channel: 'video', hosts: ['youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv', 'dailymotion.com'] },
  { channel: 'organic_social', hosts: ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'twitter.com', 'x.com', 't.co', 'linkedin.com', 'lnkd.in', 'pinterest.com', 'pin.it', 'reddit.com', 'tiktok.com', 'snapchat.com', 'threads.net', 'bsky.app', 'whatsapp.com', 'wa.me', 't.me', 'telegram.org', 'vk.com', 'weibo.com', 'tumblr.com', 'quora.com', 'discord.com', 'line.me'] },
];
const hostIs = (host: string, name: string): boolean => host === name || host.endsWith(`.${name}`);

/** The host of a referrer origin, lower-cased, or undefined. */
export function referrerHost(referrer: string | undefined): string | undefined {
  if (!referrer) return undefined;
  try { return new URL(referrer).hostname.toLowerCase() || undefined; } catch { return undefined; }
}

function channelOfReferrer(referrer: string | undefined): Channel | undefined {
  const host = referrerHost(referrer);
  if (!host) return undefined;
  for (const rule of REFERRER_RULES) {
    if (rule.pattern?.test(host) || rule.hosts?.some(name => hostIs(host, name))) return rule.channel;
  }
  return 'referral';
}

/**
 * The default channel of a visit, readable and GA4-like. Order: an AI assistant named as the utm source, the
 * campaign rules (utm medium and source), an ad click ID, a paid medium without a known source, any other campaign
 * tag, the referrer, the in-app browser (the app's social channel), then Direct. A visit with an in-app browser and
 * no referrer is therefore Organic social, never Direct.
 */
export function classifyChannel(input: ChannelInput): Channel {
  const medium = input.utm?.medium?.trim().toLowerCase();
  const source = input.utm?.source?.trim().toLowerCase();
  if (source && inGroup(source, 'ai')) return 'ai_assistant';
  if (medium || source) {
    const paid = medium ? PAID_MEDIUM.test(medium) : false;
    for (const rule of CAMPAIGN_RULES) {
      if (rule.medium && !(medium && rule.medium.test(medium))) continue;
      if (rule.source && !inGroup(source, rule.source)) continue;
      if (rule.paid !== undefined && rule.paid !== paid) continue;
      return rule.channel;
    }
  }
  if (input.adNetwork) {
    const channel = AD_NETWORK_CHANNELS[input.adNetwork];
    if (channel !== 'by_medium') return channel;
    return medium && PAID_MEDIUM.test(medium) ? 'paid_social' : 'organic_social';
  }
  if (medium && PAID_MEDIUM.test(medium)) return /^(?:cpc|ppc)$/.test(medium) ? 'paid_search' : 'other_campaign';
  const tagged = Boolean(medium || source || input.utm?.campaign || input.utm?.id);
  if (tagged) return 'other_campaign';
  const byReferrer = channelOfReferrer(input.referrer);
  if (byReferrer) return byReferrer;
  if (input.inApp) return 'organic_social';
  return 'direct';
}

/* ---------------------------------------------------------------- places and pages */

/** ISO 3166-1 alpha-2 codes that mean "no country": the databases' placeholders. */
const NOT_A_COUNTRY = new Set(['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1']);

/** An upper-case ISO 3166-1 alpha-2 country, or undefined for anything else, placeholders included. */
export function countryCode(value: string | undefined): string | undefined {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) && !NOT_A_COUNTRY.has(code) ? code : undefined;
}
/** An ISO 3166-2 code such as `US-WA` that belongs to `country`, or undefined. */
export function subdivisionCode(country: string, value: string | undefined): string | undefined {
  const raw = value?.trim().toUpperCase();
  if (!raw) return undefined;
  const code = raw.includes('-') ? raw : `${country}-${raw}`;
  return /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code) && code.startsWith(`${country}-`) ? code : undefined;
}

/** Longest entry page kept. */
export const ENTRY_PAGE_MAX_LENGTH = 200;
/** The entry page of a visit: the first page's path without query or fragment, without a trailing slash (the home page is `/`). */
export function entryPageOf(path: string): string {
  let result = path.split('#', 1)[0]!.split('?', 1)[0]!;
  if (!result.startsWith('/')) result = `/${result}`;
  if (result.length > 1) result = result.replace(/\/+$/, '') || '/';
  return result.slice(0, ENTRY_PAGE_MAX_LENGTH);
}

/** The pieces of a short source chip, in the order shown: the in-app browser (else the channel), then the place. */
export function sourceParts(source: { inApp?: InApp; channel?: Channel; country?: string }, countryName: (code: string) => string = code => code): string[] {
  const parts: string[] = [];
  if (source.inApp) parts.push(IN_APP_LABELS[source.inApp]);
  else if (source.channel) parts.push(CHANNEL_LABELS[source.channel]);
  if (source.country) parts.push(countryName(source.country));
  return parts;
}

/* ---------------------------------------------------------------- shares and names */

/** A readable country name such as `Philippines` for `PH`, in English by default. Falls back to the code. */
export function countryName(code: string, locale = 'en'): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code; } catch { return code; }
}

export interface ShareRow { key: string; label: string; count: number; /** 0 to 1 of `total`. */ share: number }
/** The largest entries of a counter as shares of `total`, most first, skipping the keys in `skip`. Ties order by key. */
export function topShares(counts: Readonly<Record<string, number>> | undefined, total: number, label: (key: string) => string, limit = 3, skip: readonly string[] = []): ShareRow[] {
  if (!counts || total <= 0) return [];
  return Object.entries(counts)
    .filter(([key, count]) => count > 0 && !skip.includes(key))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([key, count]) => ({ key, label: label(key), count, share: Math.min(1, count / total) }));
}
/** "42%", or "<1%" for a share that rounds to zero. */
export const percentText = (share: number): string => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);
