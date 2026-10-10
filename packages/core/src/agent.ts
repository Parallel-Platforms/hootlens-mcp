/*
 * Readable names for the coarse browser family and operating system a page view was recorded with. Only families are
 * stored (no versions and never the raw user agent), so this is all a list or a sentence can say. Pure, with no
 * dependencies, so the dashboard, the narrative and the MCP server word it the same way.
 */
export type AgentBrowser = 'chrome' | 'safari' | 'firefox' | 'edge' | 'other';
export type AgentOs = 'windows' | 'macos' | 'ios' | 'android' | 'linux' | 'other';

const BROWSER_LABELS: Record<AgentBrowser, string> = {
  chrome: 'Chrome', safari: 'Safari', firefox: 'Firefox', edge: 'Edge', other: 'Other browser',
};
const OS_LABELS: Record<AgentOs, string | undefined> = {
  windows: 'Windows', macos: 'macOS', ios: 'iOS', android: 'Android', linux: 'Linux', other: undefined,
};

/** The parts of a visit's browser and system that are known, each with the filter value it stands for. */
export interface AgentParts {
  browser?: { value: AgentBrowser; label: string };
  os?: { value: Exclude<AgentOs, 'other'>; label: string };
}

/**
 * The known parts. An unrecognized system (`other`) is left out, since "on other" says nothing; an unrecognized
 * browser reads "Other browser" so a visit is never described as having no browser.
 */
export function agentParts(browser?: AgentBrowser, os?: AgentOs): AgentParts {
  const system = os && os !== 'other' ? { value: os, label: OS_LABELS[os] as string } : undefined;
  return {
    ...(browser ? { browser: { value: browser, label: BROWSER_LABELS[browser] } } : {}),
    ...(system ? { os: system } : {}),
  };
}

/** "Chrome on Android", "Safari", "iOS", or an empty string when neither is known. */
export function agentLabel(browser?: AgentBrowser, os?: AgentOs): string {
  const parts = agentParts(browser, os);
  return [parts.browser?.label, parts.os?.label].filter(Boolean).join(' on ');
}
