// ============================================================================
// Planning IPC Handlers - planning:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { PlanningState } from '../../shared/types';
import type { PlanningService } from '../planning';

/**
 * 注册 Planning 相关 IPC handlers
 */
export function registerPlanningHandlers(
  ipcMain: IpcMain,
  getPlanningService: () => PlanningService | null
): void {
  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_STATE, async (): Promise<PlanningState> => {
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
      console.error('Failed to get planning state:', error);
      return { plan: null, findings: [], errors: [] };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_PLAN, async () => {
    const planningService = getPlanningService();
    if (!planningService) return null;
    try {
      return await planningService.plan.read();
    } catch (error) {
      console.error('Failed to get plan:', error);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_FINDINGS, async () => {
    const planningService = getPlanningService();
    if (!planningService) return [];
    try {
      return await planningService.findings.getAll();
    } catch (error) {
      console.error('Failed to get findings:', error);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.PLANNING_GET_ERRORS, async () => {
    const planningService = getPlanningService();
    if (!planningService) return [];
    return await planningService.errors.getAll();
  });
}
