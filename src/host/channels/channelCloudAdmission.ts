// ============================================================================
// ChannelCloudAdmission — 通道入站经云端 run 账本准入（ADR-087 S4B）
// ============================================================================
// 服务模式下非 guest 入站消息的唯一去处：先 admit（幂等键 (accountId,
// channelDeliveryId)），再按裁决跑轮次。本文件只做编排与载荷编解码；
// 桥的私有步骤（会话解析 / enrich / handleSyncMessage / 回帖）由
// ChannelAgentBridge 以 cloudSurface() 闭包面注入。桌面态（无端口）
// 完全不经过这里，通道行为一行不改。
// ============================================================================

import type { ChannelAttachment, ChannelMessage } from '../../shared/contract/channel';
import { CloudRunAccountRequiredError } from '../../shared/contract/cloudRun';
import { createLogger } from '../services/infra/logger';
import { summarizeUserFacingError } from '../security/userFacingError';
import { channelCommandText } from './channelCommandI18n';
import type { IngressMessagePart } from './ingressPipeline';
import type { InboundAccessLocale } from './inboundAccessI18n';
import type {
  ChannelCloudRunAdmission,
  ChannelCloudRunPort,
} from './channelCloudRunPort';
import { getChannelCloudRunPort } from './channelCloudRunPort';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';
import type { ChannelResponseCallback } from './channelInterface';
import type { MessageAttachment } from '../../shared/contract';

const logger = createLogger('ChannelCloudAdmission');

/**
 * 桥接层注入的步骤面。私有成员不能跨文件引用，所以在 ChannelAgentBridge
 * 内部以闭包逐个包出来（cloudSurface()）；本文件只依赖这份结构类型。
 */
export interface ChannelBridgeCloudSurface {
  sessionKey(accountId: string, message: ChannelMessage): string;
  sessionId(sessionKey: string, accountId: string, message: ChannelMessage): Promise<string>;
  orchestrator(
    sessionKey: string,
    accountId: string,
    message: ChannelMessage,
  ): Promise<AgentOrchestrator | null>;
  enrich(message: ChannelMessage): Promise<{ content: string; attachments?: ChannelAttachment[] }>;
  convertAttachments(attachments?: ChannelAttachment[]): MessageAttachment[] | undefined;
  callback(accountId: string, message: ChannelMessage): ChannelResponseCallback | null;
  turn(
    accountId: string,
    message: ChannelMessage,
    orchestrator: AgentOrchestrator,
    attachments: MessageAttachment[] | undefined,
    responseCallback: ChannelResponseCallback,
  ): Promise<boolean>;
  locale(): InboundAccessLocale;
  reply(accountId: string, message: ChannelMessage, text: string): Promise<void>;
  fail(accountId: string, message: ChannelMessage, errorMessage: string): Promise<void>;
  markPart(accountId: string, messageId: string | undefined, ok: boolean): void;
}

/** 落进账本 request_json 的通道载荷：只带回帖与轮次真正消费的字段。 */
export interface ChannelCloudRunPayload {
  accountId: string;
  message: ChannelMessage;
  /** debounce 合并进这轮的全部平台消息 id（收线后逐个标记 completed/failed）。 */
  partIds: string[];
}

/**
 * ADR-087「同一次触发来了两遍」：通道幂等键取 (accountId, 第一个 part 的平台消息 id)。
 * debounce 把同会话连发合并成一轮，整轮共用第一个消息 id；平台重推该 id 时
 * admit 命中已有行，不再起第二轮。
 */
function buildChannelDeliveryId(accountId: string, firstPartMessageId: string): string {
  return `${accountId}:${firstPartMessageId}`;
}

/**
 * 载荷编码白名单：message.raw（平台原对象 / Express res）不可序列化且无人消费——
 * channelManager.getResponseCallback 只读 message.id 与 message.context.chatId，
 * 轮次本身只消费列出的这些字段。逐字段拷贝，防平台对象混进 request_json。
 */
function encodeChannelCloudRunPayload(input: {
  accountId: string;
  message: ChannelMessage;
  partIds: string[];
}): ChannelCloudRunPayload {
  const { accountId, message, partIds } = input;
  return {
    accountId,
    partIds,
    message: {
      id: message.id,
      channelId: message.channelId,
      sender: message.sender,
      context: message.context,
      content: message.content,
      attachments: message.attachments?.map((attachment) => ({ ...attachment })),
      timestamp: message.timestamp,
      mentions: message.mentions,
      ingressAuth: message.ingressAuth,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从持久化的 request_json 还原载荷；形状不对就抛（提升轮 catch 后 settle failed）。 */
export function decodeChannelCloudRunPayload(requestJson: string | null): ChannelCloudRunPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestJson ?? 'null');
  } catch {
    throw new Error('Channel cloud run request_json is not valid JSON');
  }
  if (!isRecord(parsed) || typeof parsed.accountId !== 'string') {
    throw new Error('Channel cloud run payload has no accountId');
  }
  const rawMessage = parsed.message;
  if (!isRecord(rawMessage) || typeof rawMessage.id !== 'string' || typeof rawMessage.content !== 'string') {
    throw new Error('Channel cloud run payload has no usable message');
  }
  const rawContext = rawMessage.context;
  if (!isRecord(rawContext) || typeof rawContext.chatId !== 'string') {
    throw new Error('Channel cloud run payload has no chat context');
  }
  const payload: ChannelCloudRunPayload = {
    accountId: parsed.accountId,
    partIds: Array.isArray(parsed.partIds)
      ? parsed.partIds.filter((id): id is string => typeof id === 'string')
      : [],
    message: rawMessage as unknown as ChannelMessage,
  };
  return payload;
}

type ChannelCloudAdmitDecision =
  | { kind: 'run'; runId: string }
  | { kind: 'queued'; runId: string; queuePosition: number }
  | { kind: 'duplicate'; runId: string };

function decideChannelCloudAdmission(admission: ChannelCloudRunAdmission): ChannelCloudAdmitDecision {
  if (admission.duplicate) return { kind: 'duplicate', runId: admission.record.runId };
  if (admission.record.state === 'queued') {
    return {
      kind: 'queued',
      runId: admission.record.runId,
      queuePosition: admission.position?.queuePosition ?? 1,
    };
  }
  return { kind: 'run', runId: admission.record.runId };
}

/** 回帖只尽力而为：提示发不出去不能吞掉消息本体（与桥内既有兜底同型）。 */
async function safeReply(
  surface: ChannelBridgeCloudSurface,
  accountId: string,
  message: ChannelMessage,
  text: string,
): Promise<void> {
  try {
    await surface.reply(accountId, message, text);
  } catch (error) {
    logger.warn('[ChannelCloud] reply failed', {
      accountId,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * processIngressMessage 的云端分支：admit → 按裁决分流。
 * 任何错误都在这里收口（错误摘要回帖 + 标记失败），绝不回落本地直跑。
 */
export async function admitChannelIngressThroughCloud(
  surface: ChannelBridgeCloudSurface,
  port: ChannelCloudRunPort,
  accountId: string,
  message: ChannelMessage,
  parts: IngressMessagePart[],
): Promise<void> {
  const partIds = parts
    .map((part) => part.messageId)
    .filter((id): id is string => typeof id === 'string');
  const markParts = (ok: boolean) => {
    for (const id of partIds) surface.markPart(accountId, id, ok);
  };
  try {
    const sessionKey = surface.sessionKey(accountId, message);
    const sessionId = await surface.sessionId(sessionKey, accountId, message);
    const payload = encodeChannelCloudRunPayload({ accountId, message, partIds });
    const admission = port.admit({
      sessionId,
      channelDeliveryId: buildChannelDeliveryId(accountId, partIds[0] ?? message.id),
      requestJson: JSON.stringify(payload),
    });
    const decision = decideChannelCloudAdmission(admission);
    if (decision.kind === 'duplicate') {
      // 平台重推：这轮已交过账本（在跑或已收线），不回帖、不起第二轮。
      logger.info('[ChannelCloud] redelivery matched an existing ledger row; ignoring', {
        accountId,
        runId: decision.runId,
      });
      markParts(true);
      return;
    }
    if (decision.kind === 'queued') {
      // 一条排队提示（每条消息最多一次），然后等提升轮收线——持住会话锁，
      // 该会话的真实回复发出前同会话后续消息不插队。
      await safeReply(surface, accountId, message, channelCommandText(surface.locale(), 'cloudQueued')
        .replace('{n}', String(decision.queuePosition)));
      await port.waitForSettled(decision.runId);
      markParts(true);
      return;
    }
    markParts(await runChannelCloudTurn(surface, payload, decision.runId));
  } catch (error) {
    if (error instanceof CloudRunAccountRequiredError) {
      // 云端账号没就绪：一条白话回复，绝不回落本地直跑（ADR-087 S4B fail-closed）。
      logger.warn('[ChannelCloud] account required; replying and refusing to run locally', {
        accountId,
        messageId: message.id,
      });
      await safeReply(surface, accountId, message, channelCommandText(surface.locale(), 'cloudNotReady'));
      markParts(false);
      return;
    }
    const { summary } = summarizeUserFacingError(error, { surface: 'channel_reply' });
    logger.error('[ChannelCloud] cloud ingress failed', {
      accountId,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await surface.fail(accountId, message, summary);
    markParts(false);
  }
}

/**
 * 账本行的通道轮执行体：running 准入的内联轮与排队行的提升轮共用
 * （web 装配的 executeChannelRun 也调到这里）。跑完收线账本行；
 * 抛错或轮次失败收 failed，错误原样向上抛。
 */
export async function runChannelCloudTurn(
  surface: ChannelBridgeCloudSurface,
  payload: ChannelCloudRunPayload,
  runId: string,
): Promise<boolean> {
  const { accountId, message } = payload;
  let ok = false;
  try {
    const sessionKey = surface.sessionKey(accountId, message);
    const orchestrator = await surface.orchestrator(sessionKey, accountId, message);
    if (!orchestrator) throw new Error('Channel orchestrator unavailable for cloud run');
    const enrichment = await surface.enrich(message);
    const attachments = surface.convertAttachments(enrichment.attachments);
    const responseCallback = surface.callback(accountId, message);
    if (!responseCallback) throw new Error('Failed to get response callback for cloud run');
    ok = await surface.turn(accountId, message, orchestrator, attachments, responseCallback);
    return ok;
  } finally {
    getChannelCloudRunPort()?.settle(runId, ok ? 'succeeded' : 'failed');
  }
}
