import { z } from 'zod';
import { BLOCKED_ASSET_URL, rewriteReplayEvents } from './replay-assets';

const publicOrigin = z.string().max(300).refine(value => {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && host.includes('.') && !host.includes(':') && !/^[\d.]+$/.test(host)
      && !/(?:^|\.)(?:localhost|local|internal|localdomain|lan|intranet|corp|test|invalid|example|onion)$/.test(host) && !host.endsWith('.home.arpa');
  } catch { return false; }
}, 'Use an exact HTTPS origin with a public hostname and no path');
export const replayAssetSettingsSchema = z.object({ preserve: z.boolean().default(true), origins: z.array(publicOrigin).max(20).default([]) }).strict();
export type ReplayAssetSettings = z.infer<typeof replayAssetSettingsSchema>;

export const replayPreservationSchema = z.object({
  version: z.literal(1), status: z.enum(['legacy', 'disabled', 'pending', 'preserved', 'partial']),
  total: z.number().int().nonnegative(), preserved: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), quotaLimited: z.number().int().nonnegative(), late: z.number().int().nonnegative(),
  firstSeenAt: z.number().nonnegative().nullable(), lastCapturedAt: z.number().nonnegative().nullable(), blockedOrigins: z.array(z.string()).max(20),
});
export type ReplayPreservation = z.infer<typeof replayPreservationSchema>;

/** The same URL walker used by replay, without retaining a second copy of the recorded page. */
export function replayAssetUrls(events: readonly { type: number }[], limit = 65): string[] {
  const urls = new Set<string>();
  rewriteReplayEvents(events, { replace: (raw, absolute) => { if (urls.size < limit) urls.add((absolute ?? raw).slice(0, 2048)); return BLOCKED_ASSET_URL; } });
  return [...urls];
}
