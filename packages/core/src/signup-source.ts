/*
 * Signup attribution: the optional answer to "How did you find Hoot Lens?". It is stored on the
 * account, returned only to that account, and never required.
 */
import { z } from 'zod';

export const SIGNUP_CHANNELS = ['ai_assistant', 'search', 'social', 'friend', 'newsletter', 'other'] as const;
export const SIGNUP_ASSISTANTS = ['chatgpt', 'claude', 'perplexity', 'other'] as const;
export const SIGNUP_DETAIL_MAX = 80;

export const signupSourceSchema = z.object({
  channel: z.enum(SIGNUP_CHANNELS),
  assistant: z.enum(SIGNUP_ASSISTANTS).optional(),
  detail: z.string().trim().max(SIGNUP_DETAIL_MAX).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.assistant !== undefined && value.channel !== 'ai_assistant') ctx.addIssue({ code: 'custom', path: ['assistant'], message: 'assistant applies only to ai_assistant' });
  if (value.detail !== undefined && value.detail !== '' && value.channel !== 'other') ctx.addIssue({ code: 'custom', path: ['detail'], message: 'detail applies only to other' });
}).transform(value => {
  const { channel, assistant, detail } = value;
  return { channel, ...(assistant ? { assistant } : {}), ...(detail ? { detail } : {}) };
});
export type SignupSource = z.output<typeof signupSourceSchema>;

/** PUT /v1/account/source body: a source, or null to clear it. */
export const signupSourceRequestSchema = z.object({ source: signupSourceSchema.nullable() }).strict();

export const SIGNUP_CHANNEL_LABELS: Record<(typeof SIGNUP_CHANNELS)[number], string> = {
  ai_assistant: 'AI assistant', search: 'Search', social: 'Social media', friend: 'Friend or colleague', newsletter: 'Blog or newsletter', other: 'Other',
};
export const SIGNUP_ASSISTANT_LABELS: Record<(typeof SIGNUP_ASSISTANTS)[number], string> = { chatgpt: 'ChatGPT', claude: 'Claude', perplexity: 'Perplexity', other: 'Another assistant' };
