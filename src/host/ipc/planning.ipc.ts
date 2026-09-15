// ============================================================================
// Planning IPC Handlers - planning:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import path from 'path';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { PlanningSchemas, type PlanningDomainRequest } from '../../shared/ipc/schemas/planning';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type { PlanningState } from '../../shared/contract';
import type { PlanningService } from '../planning';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type { TaskManager } from '../task';
import type { PlanApprovalRequest } from '../../shared/contract/planApproval';
import {
  PlanApprovalError,
  resolvePlanApproval,
} from '../services/planning/planApprovalService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PlanningIPC');

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

type PlanningRequestPayload = {
  sessionId?: string | null;
};

function getRequestedSessionId(requestPayload: unknown): string | null {
  const payload = requestPayload as PlanningRequestPayload | undefined;
  const sessionId = payload?.sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
}

export function isPlanningServiceScopedToSession(
  planningService: Pick<PlanningService, 'getPlanDirectory'>,
  sessionId: string | null,
): boolean {
  if (!sessionId) return true;
  return path.basename(planningService.getPlanDirectory()) === sessionId;
}

function getScopedPlanningService(
  getPlanningService: () => PlanningService | null,
  sessionId: string | null,
): PlanningService | null {
  const planningService = getPlanningService();
  if (!planningService) return null;
  return isPlanningServiceScopedToSession(planningService, sessionId) ? planningService : null;
}

async function handleGetState(
  getPlanningService: () => PlanningService | null,
  sessionId: string | null,
): Promise<PlanningState> {
  const planningService = getScopedPlanningService(getPlanningService, sessionId);
  if (!planningService) {
    return { plan: null, findings: [], errors: [] };
  }

  try {
    const plan = await planningService.plan.read();
    const findings = await planningService.findings.getAll();
    const errors = await planningService.errors.getAll();

    return { plan, findings, errors };
  } catch (error) {
    logger.error('Failed to get planning state', error);
    return { plan: null, findings: [], errors: [] };
  }
}

async function handleGetPlan(
  getPlanningService: () => PlanningService | null,
  sessionId: string | null,
): Promise<unknown> {
  const planningService = getScopedPlanningService(getPlanningService, sessionId);
  if (!planningService) return null;
  try {
    return await planningService.plan.read();
  } catch (error) {
    logger.error('Failed to get plan', error);
    return null;
  }
}

async function handleGetFindings(
  getPlanningService: () => PlanningService | null,
  sessionId: string | null,
): Promise<unknown[]> {
  const planningService = getScopedPlanningService(getPlanningService, sessionId);
  if (!planningService) return [];
  try {
    return await planningService.findings.getAll();
  } catch (error) {
    logger.error('Failed to get findings', error);
    return [];
  }
}

async function handleGetErrors(
  getPlanningService: () => PlanningService | null,
  sessionId: string | null,
): Promise<unknown[]> {
  const planningService = getScopedPlanningService(getPlanningService, sessionId);
  if (!planningService) return [];
  return await planningService.errors.getAll();
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

interface PlanningRouteCtx {
  getPlanningService: () => PlanningService | null;
  getAppService: () => AgentApplicationService | null;
  getTaskManager: () => TaskManager | null;
}

/**
 * planning 域单源路由表（RQ-183 续作·PLANNING 刀）：原 domain switch 5 个 case 平移为 handler（rawResponse：respondApproval 的
 * NOT_INITIALIZED 原样直返，其余成功路径包 `{ success: true, data }`）。sessionId 原在 try 外由 request 算出，现由各读取 handler
 * 从 payload 算（getRequestedSessionId 改收 payload，trim 与空白判定逐字不变）。未知 action 用装配器缺省（INVALID_ACTION
 * `Unknown action: <action>`，与原文逐字一致）；抛错 code 判定原样进 resolveErrorCode（PlanApprovalError → 自带 code，其余
 * INTERNAL_ERROR），message 由装配器取 Error.message / String(error)。请求体为 null / 非对象时原实现在 try 外读 request.payload
 * 抛错（IPC reject），现返回 INVALID_ACTION。
 */
const planningHandlers: RawDomainRouteHandlers<PlanningDomainRequest, PlanningRouteCtx> = {
  getState: async (ctx, requestPayload) => ({
    success: true,
    data: await handleGetState(ctx.getPlanningService, getRequestedSessionId(requestPayload)),
  }),
  getPlan: async (ctx, requestPayload) => ({
    success: true,
    data: await handleGetPlan(ctx.getPlanningService, getRequestedSessionId(requestPayload)),
  }),
  getFindings: async (ctx, requestPayload) => ({
    success: true,
    data: await handleGetFindings(ctx.getPlanningService, getRequestedSessionId(requestPayload)),
  }),
  getErrors: async (ctx, requestPayload) => ({
    success: true,
    data: await handleGetErrors(ctx.getPlanningService, getRequestedSessionId(requestPayload)),
  }),
  respondApproval: async (ctx, requestPayload) => {
    const appService = ctx.getAppService();
    const taskManager = ctx.getTaskManager();
    if (!appService || !taskManager) {
      return { success: false, error: { code: 'NOT_INITIALIZED', message: 'Agent runtime is not initialized' } };
    }
    const data = await resolvePlanApproval(requestPayload as PlanApprovalRequest, {
      appService,
      taskManager,
    });
    return { success: true, data };
  },
};

const planningRoutes = defineDomainRoutes<PlanningDomainRequest, PlanningRouteCtx>(PlanningSchemas.REQUEST, planningHandlers, {
  rawResponse: true,
  resolveErrorCode: (error) => (error instanceof PlanApprovalError ? error.code : undefined),
});

/**
 * 注册 Planning 相关 IPC handlers
 */
export function registerPlanningHandlers(
  ipcMain: IpcMain,
  getPlanningService: () => PlanningService | null,
  getAppService: () => AgentApplicationService | null,
  getTaskManager: () => TaskManager | null,
): void {
  installDomainRoutes(ipcMain, planningRoutes, { getPlanningService, getAppService, getTaskManager });

  // ========== Legacy Handlers (Deprecated) ==========

}

// 表挂装配函数对象上供 parity 门枚举（同 registerMcpHandlers.routes 先例）
registerPlanningHandlers.routes = planningRoutes;
