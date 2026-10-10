/*
 * Crawlers and HTTP clients, recognised by their user agent. Server side only: the tracker never imports this
 * module, so the list does not travel to browsers. See automation.ts for the signals a browser reports itself.
 */
import { AUTOMATION_BITS, toolAgentBits } from './automation';

/** Search, ads and social crawlers, SEO and AI bots, and plain HTTP clients. They are not visitors, so the collector refuses them. */
const CRAWLER_AGENT = /(?:googlebot|adsbot|mediapartners-google|google-read-aloud|storebot-google|bingbot|bingpreview|msnbot|slurp|duckduckbot|baiduspider|yandex(?:bot|images|metrika)|applebot|facebookexternalhit|facebot|twitterbot|linkedinbot|ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|bytespider|gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|ccbot|perplexitybot|amazonbot|uptimerobot|pingdom|datadog|python-requests|python-urllib|curl\/|wget\/|go-http-client|okhttp\/|java\/|libwww-perl|axios\/|node-fetch|httpclient|[a-z]bot\/\d|\bcrawler\b|\bspider\b)/i;
/** A declared crawler or HTTP client. */
export const isCrawlerAgent = (userAgent: string | undefined): boolean => Boolean(userAgent) && CRAWLER_AGENT.test(userAgent as string);

/**
 * The signals a user agent string gives. The collector refuses crawlers before it gets here, so a crawler agent
 * is `bot_agent` only for a caller that reports one it cannot refuse (a test or a path that does not refuse).
 */
export const agentBits = (userAgent: string | undefined, brands?: readonly string[]): number =>
  toolAgentBits(userAgent, brands) | (CRAWLER_AGENT.test(userAgent ?? '') ? AUTOMATION_BITS.bot_agent : 0);

