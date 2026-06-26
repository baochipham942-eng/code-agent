import type { PlanningState } from '../../shared/contract';
import { getMainWindow } from '../app/window';
import { createLogger } from '../services/infra/logger';
import { planningStateEmitter } from './planningStateEmitter';
import type { PlanningService } from './planningService';

const logger = createLogger('PlanningStatePublisher');

export const PLANNING_EVENT_CHANNEL = 'planning:event';

// Re-export internal emitter for callers that go through publisher barrel.
// 真实定义在 planningStateEmitter.ts（避免拖进 main-process 重模块）。
export { planningStateEmitter } from './planningStateEmitter';

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

    // 在 IPC send 之后再 emit（保证 renderer 端优先收到）；emit 失败不阻塞函数。
    try {
      planningStateEmitter.emit('plan_updated', state);
    } catch (emitError) {
      logger.warn('planningStateEmitter.emit failed', emitError);
    }
  } catch (error) {
    logger.error('Failed to publish planning state', error);
  }
}
