// Read-only side chat IPC.
// Loads recent messages without writing them, runs runReadOnlySideChat, and
// returns the answer string. Nothing here is written back to the session.
// AbortSignal cannot cross IPC, so the ask payload carries requestId and
// SIDE_CHAT_ABORT aborts the matching in-flight controller.

import { SideChatSchemas, type SideChatFailureCause } from '../../shared/ipc/schemas';
import { AgentFailureCode } from '../../shared/contract/agentFailure';
import { runReadOnlySideChat } from '../agent/readOnlySideChat';
import { getSubagentExecutor } from '../agent/subagentExecutor';
import { defineHandler } from '../platform/ipcRegistry';
import { getDatabase } from '../services/core/databaseService';
import { getSessionManager } from '../services/infra/sessionManager';
import { getToolResolver } from '../tools/dispatch/toolResolver';

const RECENT_CONTEXT_MESSAGES = 12;

const inflight = new Map<string, AbortController>();

function sideChatError(code: 'SIDE_CHAT_ABORTED' | 'SIDE_CHAT_SESSION_NOT_FOUND'): Error {
  const error = new Error(code);
  error.name = code === 'SIDE_CHAT_ABORTED' ? 'AbortError' : 'Error';
  return error;
}

/**
 * 把底层错误（provider 文案 / executor 结构化失败码）归并成稳定 cause token。
 * 原始 payload 不出宿主——renderer 只拿到 token 去映射本地化文案，未知兜底 'unknown'。
 */
function classifySideChatFailure(input: { message?: string; failureCode?: unknown }): SideChatFailureCause {
  if (input.failureCode === AgentFailureCode.Timeout) return 'timeout';
  const text = (input.message ?? '').toLowerCase();
  if (
    /(?:^|[^0-9])(?:401|403)(?:[^0-9]|$)/.test(text)
    // 中文覆盖面：providerConnectionTest「认证失败/权限不足」、agentEngine「认证失败…
    // 凭据」、国内 provider 直出的「请检查访问凭证/凭证无效/未授权/无权限」等自由文案。
    || /unauthorized|forbidden|authentication|invalid[ _/-]?api[ _/-]?key|invalid[ _/-]?token|incorrect[ _/-]?api|api[ _/-]?key[ _/-]?(?:invalid|not[ _/-]?valid|expired|error)|鉴权|授权失败|认证失败|认证未通过|访问凭证|凭证无效|未授权|无权限|权限不足|密钥无效|令牌无效/.test(text)
  ) {
    return 'auth';
  }
  if (/timeout|timed?[ _-]?out|etimedout|econnaborted|deadline|超时/.test(text)) return 'timeout';
  return 'unknown';
}

async function askSideChat(payload: { sessionId: string; question: string; requestId: string }): Promise<{ answer?: string; failure?: { cause: SideChatFailureCause } }> {
  const manager = getSessionManager();
  if (!manager.getSessionRuntimeState(payload.sessionId)) {
    throw sideChatError('SIDE_CHAT_SESSION_NOT_FOUND');
  }

  const stored = getDatabase().getSession(payload.sessionId);
  const provider = stored?.modelConfig?.provider?.trim() ?? '';
  const model = stored?.modelConfig?.model?.trim() ?? '';
  if (!stored || !provider || !model) {
    throw sideChatError('SIDE_CHAT_SESSION_NOT_FOUND');
  }

  const parentMessages = await manager.getRecentMessages(payload.sessionId, RECENT_CONTEXT_MESSAGES);
  const cwd = stored.workingDirectory || stored.workspace || process.cwd();
  inflight.get(payload.requestId)?.abort();
  const controller = new AbortController();
  inflight.set(payload.requestId, controller);

  try {
    const executor = getSubagentExecutor();
    // executor 失败以 success:false 返回而非抛错；在注入边界拦截，失败信息
    // 供 askSideChat 归类 cause，不改动 runReadOnlySideChat 的字符串契约。
    let executorFailure: { message?: string; failureCode?: unknown } | undefined;
    const answer = await runReadOnlySideChat(
      {
        executor: {
          execute: async (request) => {
            const result = await executor.execute(request);
            if (!result.success) executorFailure = { message: result.error, failureCode: result.failureCode };
            return result;
          },
        },
        baseContext: {
          sessionId: payload.sessionId,
          cwd,
          modelConfig: { provider, model },
          resolver: getToolResolver(),
          permission: { request: async () => false },
          events: { emit() { /* side chat does not touch the main conversation stream */ } },
          // 侧聊不是代理活动：不进 subagentContextStore，否则「专家」面板会自动
          // 弹出并滞留「工作中」行（N-BTW-GUI-FLOATER r2 Gap 2）。
          suppressContextPublishing: true,
          abortSignal: controller.signal,
        },
        parentMessages,
      },
      payload.question,
    );
    if (controller.signal.aborted) throw sideChatError('SIDE_CHAT_ABORTED');
    if (executorFailure) return { failure: { cause: classifySideChatFailure(executorFailure) } };
    return { answer };
  } catch (err) {
    if (controller.signal.aborted) throw sideChatError('SIDE_CHAT_ABORTED');
    if (err instanceof Error && err.message.startsWith('SIDE_CHAT_')) throw err;
    return { failure: { cause: classifySideChatFailure({ message: err instanceof Error ? err.message : String(err) }) } };
  } finally {
    if (inflight.get(payload.requestId) === controller) inflight.delete(payload.requestId);
  }
}

export function registerSideChatHandlers(): void {
  defineHandler(SideChatSchemas.ASK, async (_event, payload) => askSideChat(payload));
  defineHandler(SideChatSchemas.ABORT, async (_event, payload) => {
    const controller = inflight.get(payload.requestId);
    if (!controller) return { aborted: false };
    controller.abort();
    return { aborted: true };
  });
}
