// ============================================================================
// Planning IPC Handlers - planning:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import path from 'path';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { PlanningState } from '../../shared/contract';
import type { PlanningService } from '../planning';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PlanningIPC');

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

type PlanningRequestPayload = {
  sessionId?: string | null;
};

function getRequestedSessionId(request: IPCRequest): string | null {
  const payload = request.payload as PlanningRequestPayload | undefined;
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

/**
 * 注册 Planning 相关 IPC handlers
 */
export function registerPlanningHandlers(
  ipcMain: IpcMain,
  getPlanningService: () => PlanningService | null
): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.PLANNING, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action } = request;
    const sessionId = getRequestedSessionId(request);

    try {
      let data: unknown;

      switch (action) {
        case 'getState':
          data = await handleGetState(getPlanningService, sessionId);
          break;
        case 'getPlan':
          data = await handleGetPlan(getPlanningService, sessionId);
          break;
        case 'getFindings':
          data = await handleGetFindings(getPlanningService, sessionId);
          break;
        case 'getErrors':
          data = await handleGetErrors(getPlanningService, sessionId);
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

}
