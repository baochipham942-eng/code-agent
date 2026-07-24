// ============================================================================
// HTML 产物人工编辑持久化 —— 三处一起写，缺一即崩（S5 P3）
// ============================================================================
//
// 崩点不是写-写冲突（agent 重新生成是另起一条消息，改不动旧产物），而是「模型
// 基于没有用户修改的旧版重新生成」。根因：AgentOrchestrator.messages 是会话加载时
// 灌的内存副本，只写 DB 的话当前会话的模型永远看不到修改，下一轮照旧版改回去。
//
// 所以要写三处：
//   1. DB messages.content        —— 唯一真源，重启/web/cli/导出/云同步全靠它
//   2. 活跃 orchestrator 内存 messages —— 当前会话下一轮模型读的是它（setSessionContext 回灌）
//   3. fence 正文里的编辑标记      —— 让模型「知道」这里被人动过，别悄悄改回去

import type {
  GenerativeUiEditPersistRequest,
  GenerativeUiEditPersistResult,
} from '../../../shared/contract/generativeUI';
import {
  applyEditMarker,
  extractGenerativeUiFenceBody,
  hashGenerativeUiBody,
  replaceGenerativeUiFence,
  stripEditMarker,
} from '../../../shared/generativeUIEdit';
import { getSessionManager } from '../infra/sessionManager';
import { getTaskManager } from '../../task';
import { createLogger } from '../infra/logger';

const logger = createLogger('GenerativeUIEditPersistence');

/**
 * web /run 路径读的是 webSessionStore 的消息投影缓存，不是 orchestrator 也不是直接 DB。
 * 而所有桌面发行版实际都跑 Tauri+webServer 这条路。所以落库后除了回灌 orchestrator，
 * 还必须让 web 投影失效——否则下一轮模型读旧投影，看不到用户的修改（崩法 A）。
 * 用注入 hook 而非 host→web import，保持分层：web 启动时把失效函数登记进来。
 */
let invalidateWebProjection: ((sessionId: string) => void) | null = null;
export function setGenerativeUiEditProjectionInvalidator(fn: (sessionId: string) => void): void {
  invalidateWebProjection = fn;
}

/** 当天日期，贴进编辑标记。抽出来只为可测（测试注入固定日期）。 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function persistGenerativeUiEdit(
  request: GenerativeUiEditPersistRequest,
  now: () => string = today,
): Promise<GenerativeUiEditPersistResult> {
  const { sessionId, messageId, sourceOrdinal, baseHash, newCode, fields } = request;
  const sessionManager = getSessionManager();

  const messages = await sessionManager.getMessages(sessionId);
  // 主键：renderer 传的 messageId。但流式刚生成的消息，renderer 的 id 可能还没和
  // DB id 对齐（dogfood 抓到：fresh 消息 id ≠ DB id → find 落空 → 编辑静默丢）。
  // 兜底：用 baseHash 内容寻址——它就是用户编辑那段 fence 的哈希，唯一定位到消息。
  const byId = messages.find((item) => item.id === messageId);
  const message = byId ?? messages.find((item) => {
    if (item.role !== 'assistant') return false;
    const body = extractGenerativeUiFenceBody(item.content, sourceOrdinal);
    return body !== null && hashGenerativeUiBody(body) === baseHash;
  });
  if (!message) return { persisted: false, reason: 'message_not_found' };

  const currentBody = extractGenerativeUiFenceBody(message.content, sourceOrdinal);
  if (currentBody === null) return { persisted: false, reason: 'ordinal_out_of_range' };

  // 对账：库里当前那份 != 用户开始编辑时那份 —— 有人在中间改过了（云同步/另一处编辑），
  // fail-closed，不拿旧基准覆盖新内容。
  if (hashGenerativeUiBody(currentBody) !== baseHash) {
    logger.info('Generative UI edit conflict — base hash mismatch', { messageId, sourceOrdinal });
    return { persisted: false, reason: 'conflict' };
  }

  // 贴新鲜标记（先清掉 newCode 里可能带的旧标记，不让它堆叠）
  const newBody = applyEditMarker(stripEditMarker(newCode), now(), fields);
  const replaced = replaceGenerativeUiFence(message.content, sourceOrdinal, newBody);
  if (!replaced.ok) return { persisted: false, reason: 'ordinal_out_of_range' };

  // 1) + 2)：updateMessage 写库并同步会话缓存；setSessionContext 回灌活跃 orchestrator，
  // 让当前会话下一轮模型读到新版。缺第二步就是那个「悄悄改回去」的崩法。
  // 用 message.id（DB 真 id），不用传进来的 messageId——后者在 fresh 流式消息上可能是旧的。
  await sessionManager.updateMessage(message.id, { content: replaced.content });
  const fresh = await sessionManager.getMessages(sessionId);
  getTaskManager().setSessionContext(sessionId, fresh);
  // web /run 的真正上下文来源，别漏——这是 dogfood 抓到的崩法 A 根因
  invalidateWebProjection?.(sessionId);

  return { persisted: true };
}
