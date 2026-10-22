// N-MAXLINES-MINEFIELD-2-FU1-S6 move-only extraction: stateless identity/key
// helpers plus the ownership-logging probe, moved byte-identical from
// SurfaceExecutionRuntime.ts (bodies unchanged; `this.sessions`/`this.runRegistry`
// became parameters). Identity params use the same structural type the runtime's
// assertActiveRun already inlines, so this module stays cycle-free.
import type { InteractiveSurfaceSessionV1 } from '../../../shared/contract/surfaceExecution';
import type { RunRegistry } from '../../runtime/runRegistry';
import { createLogger } from '../infra/logger';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import type { BrowserTabLeaseSubjectV1 } from './BrowserTabLeaseService';
import type { SurfaceSessionManager } from './SurfaceSessionManager';

const surfaceOwnershipLogger = createLogger('SurfaceExecutionRuntime.ownership');

// 症状 4（跨会话状态泄漏）取证探针（排查报告 §4）：现行三层过滤代码本身是干净的，
// 泄漏源头未定。这里不改行为、不拦截——只在 surface 会话创建入口校验
// identity.conversationId（= 工具上下文的 context.sessionId）非空、且与该 runId
// 已登记的发起会话一致，不一致/为空时打一条结构化 error 日志（带两个 ID + 调用栈），
// 把「下次泄漏」从看得见但复现不了，变成可取证。
export function assertSurfaceSessionOwnershipForLog(
  runRegistry: RunRegistry,
  identity: { conversationId: string; runId: string; agentId: string },
): void {
  const claimedConversationId = identity.conversationId?.trim();
  const registeredConversationId = claimedConversationId ? runRegistry.get(identity.runId)?.context.sessionId : undefined;
  if (!claimedConversationId || (registeredConversationId && registeredConversationId !== claimedConversationId)) {
    surfaceOwnershipLogger.error(
      claimedConversationId ? 'surface 会话归属与该 runId 登记的发起会话不一致' : 'surface 会话创建时 conversationId 为空',
      { claimedConversationId, registeredConversationId, runId: identity.runId, agentId: identity.agentId, stack: new Error().stack },
    );
  }
}

export function subjectFor(session: InteractiveSurfaceSessionV1): SurfaceGrantSubjectV1 {
  return { sessionId: session.sessionId, runId: session.runId, agentId: session.agentId };
}

export function browserBindingKey(
  identity: { conversationId: string; runId: string; agentId: string },
  provider: string,
  surfaceSessionId: string,
  surfaceStateId: string,
): string {
  return JSON.stringify([
    identity.conversationId,
    identity.runId,
    identity.agentId,
    provider,
    surfaceSessionId,
    surfaceStateId,
  ]);
}

export function browserLeaseSubjectFor(
  session: InteractiveSurfaceSessionV1,
): BrowserTabLeaseSubjectV1 {
  return {
    conversationId: session.conversationId,
    sessionId: session.sessionId,
    runId: session.runId,
    agentId: session.agentId,
  };
}

export function computerBindingKey(
  identity: { conversationId: string; runId: string; agentId: string },
  provider: string,
  providerStateId: string,
): string {
  return JSON.stringify([
    identity.conversationId,
    identity.runId,
    identity.agentId,
    provider,
    providerStateId,
  ]);
}

export function findBrowserSessionId(
  sessions: SurfaceSessionManager,
  identity: { conversationId: string; runId: string; agentId: string },
  provider: string,
): string {
  return sessions.findActive({
    conversationId: identity.conversationId,
    runId: identity.runId,
    agentId: identity.agentId,
    surface: 'browser',
    provider,
  })?.sessionId || 'unbound';
}

export function findComputerSessionId(
  sessions: SurfaceSessionManager,
  identity: { conversationId: string; runId: string; agentId: string },
  provider: string,
): string {
  return sessions.findActive({
    conversationId: identity.conversationId,
    runId: identity.runId,
    agentId: identity.agentId,
    surface: 'computer',
    provider,
  })?.sessionId || 'unbound';
}
