// ============================================================================
// 自动 agent 路由解析（从 agentOrchestrator.ts 逐字搬出，
// N-MAXLINES-MINEFIELD-2-FU1-S2）。
// ============================================================================

import { getRoutingService } from '../../routing';
import type { RoutingContext, RoutingResolution } from '../../../shared/contract/agentRouting';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentOrchestrator');

export async function resolveAgentRouting(
  userMessage: string,
  sessionId: string | undefined,
  workingDirectory: string,
): Promise<RoutingResolution | null> {
  try {
    const routingService = getRoutingService();

    if (!routingService.isInitialized()) {
      await routingService.initialize(workingDirectory);
    }

    const context: RoutingContext = {
      workingDirectory,
      userMessage,
      sessionId,
    };

    const resolution = routingService.resolve(context);

    if (resolution.agent.id === 'default' && resolution.score <= 0) {
      return null;
    }

    return resolution;
  } catch (error) {
    logger.warn('Agent routing failed, using default', { error });
    return null;
  }
}
