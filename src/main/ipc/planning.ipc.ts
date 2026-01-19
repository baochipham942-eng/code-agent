// ============================================================================
// Planning IPC Handlers - planning:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { PlanningState } from '../../shared/types';
import type { PlanningService } from '../planning';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PlanningIPC');

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleGetState(getPlanningService: () => PlanningService | null): Promise<PlanningState> {
  const planningService = getPlanningService();
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

async function handleGetPlan(getPlanningService: () => PlanningService | null): Promise<unknown> {
  const planningService = getPlanningService();
  if (!planningService) return null;
  try {
    return await planningService.plan.read();
  } catch (error) {
    logger.error('Failed to get plan', error);
    return null;
  }
}

async function handleGetFindings(getPlanningService: () => PlanningService | null): Promise<unknown[]> {
  const planningService = getPlanningService();
  if (!planningService) return [];
  try {
    return await planningService.findings.getAll();
  } catch (error) {
    logger.error('Failed to get findings', error);
    return [];
  }
}

async function handleGetErrors(getPlanningService: () => PlanningService | null): Promise<unknown[]> {
  const planningService = getPlanningService();
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

    try {
      let data: unknown;

      switch (action) {
        case 'getState':
          data = await handleGetState(getPlanningService);
          break;
        case 'getPlan':
          data = await handleGetPlan(getPlanningService);
          break;
        case 'getFindings':
          data = await handleGetFindings(getPlanningService);
          break;
        case 'getErrors':
          data = await handleGetErrors(getPlanningService);
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

  /** @deprecated Use IPC_DOMAINS.PLANNING with action: 'getState' */
  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_STATE, async () => handleGetState(getPlanningService));

  /** @deprecated Use IPC_DOMAINS.PLANNING with action: 'getPlan' */
  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_PLAN, async () => handleGetPlan(getPlanningService));

  /** @deprecated Use IPC_DOMAINS.PLANNING with action: 'getFindings' */
  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_FINDINGS, async () => handleGetFindings(getPlanningService));

  /** @deprecated Use IPC_DOMAINS.PLANNING with action: 'getErrors' */
  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_ERRORS, async () => handleGetErrors(getPlanningService));
}
