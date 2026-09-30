import { z } from 'zod';
import { IPC_CHANNELS } from '../legacy-channels';
import { channelSchema } from './core';

const SideChatAskPayloadSchema = z.object({
  sessionId: z.string().min(1),
  question: z.string().min(1),
  requestId: z.string().min(1),
});

const SideChatAskResponseSchema = z.object({
  answer: z.string(),
});

const SideChatAbortPayloadSchema = z.object({
  requestId: z.string().min(1),
});

const SideChatAbortResponseSchema = z.object({
  aborted: z.boolean(),
});

export const SideChatSchemas = {
  ASK: channelSchema({
    channel: IPC_CHANNELS.SIDE_CHAT_ASK,
    payload: SideChatAskPayloadSchema,
    response: SideChatAskResponseSchema,
  }),
  ABORT: channelSchema({
    channel: IPC_CHANNELS.SIDE_CHAT_ABORT,
    payload: SideChatAbortPayloadSchema,
    response: SideChatAbortResponseSchema,
  }),
} as const;
