// ============================================================================
// Session Automation IPC
// ============================================================================

import { ipcHost } from '../platform';
import { SessionAutomationSchemas, type SessionAutomationDomainRequest } from '../../shared/ipc/schemas/sessionAutomation';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getSessionAutomationService } from '../services/sessionAutomation';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionAutomationIPC');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(source: unknown, field: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[field];
  return typeof value === 'string' ? value : undefined;
}

function getStringArray(source: unknown, field: string): string[] {
  if (!isRecord(source)) return [];
  const value = source[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * sessionAutomation 域单源路由表（RQ-183 续作·SESSION_AUTOMATION 刀）：原 domain switch 7 个大括号 case 平移为默认模式 handler
 * （case 体原样，末尾 `return { success: true, data: X } satisfies IPCResponse` 改 `return X`；缺参数的 `throw new Error('缺少 …')` 原样
 * 保留）。service 原在 try 外取（抛错即 IPC reject），现每个 handler 首行取、抛错落 SESSION_AUTOMATION_ERROR。未知 action →
 * UNKNOWN_ACTION + `Unknown session automation action:`；抛错进 mapError：原样记日志 + SESSION_AUTOMATION_ERROR（非 Error 为
 * 'Unknown error'）。请求体为 null / 非对象时原实现在 try 内读 request.action 抛错落 SESSION_AUTOMATION_ERROR，现返回 UNKNOWN_ACTION。
 */
const sessionAutomationRoutes = defineDomainRoutes<SessionAutomationDomainRequest, void>(SessionAutomationSchemas.REQUEST, {
  listBySession: (_ctx, payload) => {
    const service = getSessionAutomationService();
    const sessionId = getString(payload, 'sessionId');
    if (!sessionId) throw new Error('缺少 sessionId');
    return service.listBySessionIds([sessionId]);
  },
  summarizeSessions: (_ctx, payload) => {
    const service = getSessionAutomationService();
    const sessionIds = getStringArray(payload, 'sessionIds');
    return service.summarizeSessions(sessionIds);
  },
  getSessionSummary: (_ctx, payload) => {
    const service = getSessionAutomationService();
    const sessionId = getString(payload, 'sessionId');
    if (!sessionId) throw new Error('缺少 sessionId');
    return service.summarizeSessions([sessionId])[sessionId];
  },
  listPendingReview: (_ctx, _payload) => {
    const service = getSessionAutomationService();
    return service.listPendingReview();
  },
  listParkedApprovals: (_ctx, _payload) => {
    const service = getSessionAutomationService();
    return service.listParkedApprovals();
  },
  countPendingReview: (_ctx, _payload) => {
    const service = getSessionAutomationService();
    return service.countPendingReview();
  },
  markReviewed: (_ctx, payload) => {
    const service = getSessionAutomationService();
    const automationId = getString(payload, 'automationId');
    if (!automationId) throw new Error('缺少 automationId');
    return service.markReviewed(automationId);
  },
}, {
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown session automation action: ${String(action)}`,
  mapError: (error) => {
    logger.error('Session automation IPC error:', error);
    return { code: 'SESSION_AUTOMATION_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
  },
});

export function registerSessionAutomationHandlers(): void {
  installDomainRoutes(ipcHost, sessionAutomationRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerSessionAutomationHandlers.routes = sessionAutomationRoutes;
