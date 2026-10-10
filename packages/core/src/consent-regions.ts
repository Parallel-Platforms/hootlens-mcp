/*
 * Regions for regional consent. Zod-free so the dashboard, API and tests share one matcher.
 *
 * Codes are ISO 3166-1 alpha-2 countries ("DE"), ISO 3166-2 subdivisions ("US-WA") and the group
 * shortcuts EEA, EU, UK and CH. UK is the group for the United Kingdom, whose ISO country code is GB.
 */
export const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'] as const;
export const EEA_COUNTRIES = [...EU_COUNTRIES, 'IS', 'LI', 'NO'] as const;

const GROUPS: Record<string, readonly string[]> = {EEA: EEA_COUNTRIES, EU: EU_COUNTRIES, UK: ['GB'], CH: ['CH']};

/** Regions asked first by default. */
export const DEFAULT_CONSENT_REGIONS: readonly string[] = ['EEA', 'UK', 'CH', 'US-WA', 'US-NV', 'US-CT'];
export const MAX_CONSENT_REGIONS = 60;

/** Names for the codes the dashboard offers. Any valid code is accepted; unnamed ones show as the code. */
export const CONSENT_REGION_LABELS: Readonly<Record<string, string>> = {
  EEA: 'European Economic Area', EU: 'European Union', UK: 'United Kingdom', CH: 'Switzerland',
  'US-WA': 'Washington State', 'US-NV': 'Nevada', 'US-CT': 'Connecticut', 'US-CA': 'California',
  CA: 'Canada', BR: 'Brazil', AU: 'Australia', JP: 'Japan', KR: 'South Korea', ZA: 'South Africa',
};
export const consentRegionLabel = (code: string): string => CONSENT_REGION_LABELS[code] ?? code;

const COUNTRY = /^[A-Z]{2}$/;
const SUBDIVISION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

/** True for a group shortcut, a country or a subdivision code, in upper case. */
export const isConsentRegionCode = (code: string): boolean => code in GROUPS || COUNTRY.test(code) || SUBDIVISION.test(code);

/** Upper-cases, trims and de-duplicates a list. Returns null when any entry is not a valid code. */
export function normalizeConsentRegions(codes: readonly string[]): string[] | null {
  const result = new Set<string>();
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (!isConsentRegionCode(code)) return null;
    result.add(code);
  }
  return [...result];
}

/** A visitor's place as the geo sources report it. `subdivision` is "WA" or "US-WA". */
export interface VisitorRegion { country: string; subdivision?: string }

/** The country and ISO 3166-2 code of a visitor, or undefined when the country is not a valid code. */
export function normalizeVisitorRegion(region: VisitorRegion): {country: string; subdivision?: string} | undefined {
  const country = region.country.trim().toUpperCase();
  if (!COUNTRY.test(country)) return undefined;
  const raw = region.subdivision?.trim().toUpperCase();
  if (!raw) return {country};
  const subdivision = raw.includes('-') ? raw : `${country}-${raw}`;
  return SUBDIVISION.test(subdivision) && subdivision.startsWith(`${country}-`) ? {country, subdivision} : {country};
}

/**
 * Whether a visitor is in a listed region: `true` or `false`, or `undefined` when the list cannot be
 * answered from what is known, which callers treat as "ask first". That happens when the visitor's
 * country has listed subdivisions but their subdivision is unknown.
 */
export function matchConsentRegion(regions: readonly string[], visitor: VisitorRegion): boolean | undefined {
  const place = normalizeVisitorRegion(visitor);
  if (!place) return undefined;
  const list = new Set(regions.map(code => code.toUpperCase()));
  if (list.has(place.country)) return true;
  for (const [group, countries] of Object.entries(GROUPS)) {
    if (list.has(group) && countries.includes(place.country)) return true;
  }
  if (place.subdivision && list.has(place.subdivision)) return true;
  const listsSubdivisionsOfCountry = [...list].some(code => code.startsWith(`${place.country}-`));
  return listsSubdivisionsOfCountry && !place.subdivision ? undefined : false;
}
