import type { PlanningState } from '../../shared/contract';
import { getMainWindow } from '../app/window';
import { createLogger } from '../services/infra/logger';
import type { PlanningService } from './planningService';

const logger = createLogger('PlanningStatePublisher');

export const PLANNING_EVENT_CHANNEL = 'planning:event';

export async function publishPlanningStateToRenderer(
  planningService: PlanningService
): Promise<void> {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;

  try {
    const plan = await planningService.plan.read();
    const findings = await planningService.findings.getAll();
    const errors = await planningService.errors.getAll();

    const state: PlanningState = {
      plan,
      findings,
      errors,
    };

    mainWindow.webContents.send(PLANNING_EVENT_CHANNEL, {
      type: 'plan_updated',
      data: state,
    });
  } catch (error) {
    logger.error('Failed to publish planning state', error);
  }
}
