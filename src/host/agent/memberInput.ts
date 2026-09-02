// ============================================================================
// sendMemberInput — 用户直接给一位成员补话/改道，宿主按成员类型三分路由（N-SUBAGENT-INPUT）
// ----------------------------------------------------------------------------
// 不造新通道。三类成员各走自己早就有的那条：
//   expert（专家团成员） → swarm:send-user-message（协调器 durable 入队 → SpawnGuard 回退 → 落库）
//   agent（spawn 子代理） → 同上；没有 run 作用域或处理器投不到时退到 SpawnGuard 按会话直投
//   task（委派后台任务）  → SessionCommandCenter.steer（排队中追加任务书；运行中 interruptAndContinue）
// 已收工/失败/取消的成员一律拒收不排队（与 N-TASKWAKE「不排队」取舍一致）。
// ============================================================================

import type { Message } from '../../shared/contract';
import type {
  MemberInputReceipt,
  MemberInputRequest,
} from '../../shared/contract/memberInput';
import type { RuntimeInputMode } from '../../shared/contract/conversationEnvelope';
import { RUNTIME_INPUT_REDIRECT_LINE } from '../../shared/constants/runtimeInput';
import type { AgentMessage } from './spawnGuard';
import type { SessionCommandTask, SessionTaskReferenceResult } from '../services/commandCenter/sessionCommandCenter';

export interface MemberInputDeps {
  sendSwarmUserMessage(payload: {
    sessionId: string;
    runId: string;
    agentId: string;
    message: string;
    displayMessage?: string;
    messageId?: string;
    timestamp?: number;
    metadata?: Message['metadata'];
  }): Promise<{ delivered: boolean; persisted: boolean }>;
  spawnGuard: {
    get(id: string, scope?: { sessionId: string }): { status?: string } | undefined;
    sendMessage(id: string, message: AgentMessage, scope?: { sessionId: string }): boolean;
  };
  commandCenter: {
    list(sessionId: string): Pick<SessionCommandTask, 'id' | 'status'>[];
    steer(
      sessionId: string,
      target: string,
      instruction: string,
      options: { origin: 'user'; mode: RuntimeInputMode; memberName: string; messageId?: string; timestamp?: number },
    ): Promise<SessionTaskReferenceResult>;
  };
}

const LIVE_SPAWN_STATUSES = new Set(['running', 'running-recovered']);

/**
 * 团队/spawn 成员的执行器只在两轮之间抽干收件箱、没有中断当前工具的语义，
 * 「改道」= 下一轮生效；把改道指令行拼进投递文本，让成员知道这不是普通补充。
 */
function deliveryText(message: string, mode: RuntimeInputMode): string {
  return mode === 'redirect' ? `${message}\n\n${RUNTIME_INPUT_REDIRECT_LINE}` : message;
}

export async function sendMemberInput(
  request: MemberInputRequest,
  deps: MemberInputDeps,
): Promise<MemberInputReceipt> {
  const message = request.message.trim();
  if (!message) throw new Error('message is required');
  const memberInput = { memberId: request.memberId, memberName: request.memberName, mode: request.mode };

  if (request.kind === 'task') {
    const result = await deps.commandCenter.steer(request.sessionId, request.memberId, message, {
      origin: 'user',
      mode: request.mode,
      memberName: request.memberName,
      messageId: request.messageId,
      timestamp: request.timestamp,
    });
    if (result.outcome === 'resolved') {
      // 排队：命令中心落记录；运行中：运行时 injectSteerMessage 落记录——两条都已持久
      return result.task.status === 'queued'
        ? { outcome: 'delivered', effect: 'queued', persisted: true }
        : { outcome: 'delivered', effect: 'now', persisted: true };
    }
    const known = deps.commandCenter.list(request.sessionId).some((task) => task.id === request.memberId);
    return { outcome: 'rejected', reason: known ? 'finished' : 'not_found' };
  }

  if (request.runId) {
    const result = await deps.sendSwarmUserMessage({
      sessionId: request.sessionId,
      runId: request.runId,
      agentId: request.memberId,
      // 投给成员的带指令行；落库/投递账本用原话（刷新后不能把运行时脚手架露给用户）
      message: deliveryText(message, request.mode),
      displayMessage: message,
      messageId: request.messageId,
      timestamp: request.timestamp,
      metadata: {
        workbench: {
          routingMode: 'direct',
          targetAgentIds: [request.memberId],
          runtimeInputMode: request.mode,
        },
        memberInput,
      },
    });
    if (result.delivered) return { outcome: 'delivered', effect: 'next_step', persisted: result.persisted };
    if (request.kind === 'expert') return { outcome: 'rejected', reason: 'finished' };
  }

  // spawn 子代理：SpawnGuard 回退（没有 run 作用域、或处理器按作用域投不到时）
  const scope = { sessionId: request.sessionId };
  const agent = deps.spawnGuard.get(request.memberId, scope);
  if (!agent) return { outcome: 'rejected', reason: 'not_found' };
  if (!LIVE_SPAWN_STATUSES.has(agent.status ?? '')) return { outcome: 'rejected', reason: 'finished' };
  const sent = deps.spawnGuard.sendMessage(request.memberId, {
    type: 'text',
    from: 'user',
    payload: deliveryText(message, request.mode),
    timestamp: request.timestamp ?? Date.now(),
  }, scope);
  return sent
    ? { outcome: 'delivered', effect: 'next_step', persisted: false }
    : { outcome: 'rejected', reason: 'finished' };
}
