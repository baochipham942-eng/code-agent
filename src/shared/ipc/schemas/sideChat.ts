import { z } from 'zod';
import { IPC_CHANNELS } from '../legacy-channels';
import { channelSchema } from './core';

const SideChatAskPayloadSchema = z.object({
  sessionId: z.string().min(1),
  question: z.string().min(1),
  requestId: z.string().min(1),
});

/**
 * 失败原因的稳定 token（宿主侧分类，renderer 按此映射本地化文案）。
 * 走成功信封而非异常：web 兜底路由把 handler 返回值原样透传，throw 的
 * message 会在 httpTransport 解包时丢成 undefined，原因到不了渲染层。
 */
export const SIDE_CHAT_FAILURE_CAUSES = ['auth', 'quota', 'timeout', 'network', 'unknown'] as const;
export type SideChatFailureCause = (typeof SIDE_CHAT_FAILURE_CAUSES)[number];

const SideChatAskResponseSchema = z.object({
  answer: z.string().optional(),
  failure: z.object({ cause: z.enum(SIDE_CHAT_FAILURE_CAUSES) }).optional(),
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
