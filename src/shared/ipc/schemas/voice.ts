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

// ── 声纹（N-L7-SPK）。overview 里只有状态与时间戳，embedding 向量绝不过 IPC。 ──

const VoiceprintOverviewSchema = z.object({
  status: z.object({
    registered: z.boolean(),
    createdAt: z.number().optional(),
    lastMatchedAt: z.number().optional(),
    sampleCount: z.number().optional(),
  }),
  runtime: z.object({
    modelReady: z.boolean(),
    runtimeReady: z.boolean(),
  }),
  callActive: z.boolean(),
});

const VoiceprintRegisterResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), overview: VoiceprintOverviewSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(['no_active_call', 'no_samples']) }),
]);

function voiceprintAction<A extends string>(action: A) {
  return z.object({ action: z.literal(action), requestId: z.string().optional() });
}

export const VoiceSchemas = {
  INJECT_USER_TEXT: channelSchema({
    channel: IPC_DOMAINS.VOICE,
    payload: InjectUserTextRequestSchema,
    response: InjectUserTextResponseSchema,
  }),
  VOICEPRINT_OVERVIEW: channelSchema({
    channel: IPC_DOMAINS.VOICE,
    payload: voiceprintAction('voiceprintOverview'),
    response: IPCResponseSchema(VoiceprintOverviewSchema),
  }),
  VOICEPRINT_REGISTER: channelSchema({
    channel: IPC_DOMAINS.VOICE,
    payload: voiceprintAction('voiceprintRegister'),
    response: IPCResponseSchema(VoiceprintRegisterResultSchema),
  }),
  VOICEPRINT_CLEAR: channelSchema({
    channel: IPC_DOMAINS.VOICE,
    payload: voiceprintAction('voiceprintClear'),
    response: IPCResponseSchema(VoiceprintOverviewSchema),
  }),
  VOICEPRINT_PREPARE_MODEL: channelSchema({
    channel: IPC_DOMAINS.VOICE,
    payload: voiceprintAction('voiceprintPrepareModel'),
    response: IPCResponseSchema(VoiceprintOverviewSchema),
  }),
} as const;

export type VoiceUserTextInjectionRequest = z.infer<typeof InjectUserTextRequestSchema>;
