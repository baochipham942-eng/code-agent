import { z } from 'zod';
import type { VoiceUserTextInjectionResult } from '../../contract/voice';
import { IPC_DOMAINS } from '../domains';
import { IPCResponseSchema, channelSchema } from './core';

const VoiceUserTextInjectionPayloadSchema = z.object({
  neoSessionId: z.string().min(1),
  text: z.string().trim().min(1),
});

const VoiceUserTextInjectionResultSchema: z.ZodType<VoiceUserTextInjectionResult> = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('injected') }),
  z.object({
    outcome: z.literal('fallback'),
    reason: z.enum([
      'empty_text',
      'no_active_call',
      'tools_unavailable',
      'transport_unavailable',
      'injection_rejected',
    ]),
  }),
]);

const InjectUserTextRequestSchema = z.object({
  action: z.literal('injectUserText'),
  payload: VoiceUserTextInjectionPayloadSchema,
  requestId: z.string().optional(),
});

const InjectUserTextResponseSchema = IPCResponseSchema(VoiceUserTextInjectionResultSchema);

export const VoiceSchemas = {
  INJECT_USER_TEXT: channelSchema({
    channel: IPC_DOMAINS.VOICE,
    payload: InjectUserTextRequestSchema,
    response: InjectUserTextResponseSchema,
  }),
} as const;

export type VoiceUserTextInjectionRequest = z.infer<typeof InjectUserTextRequestSchema>;
