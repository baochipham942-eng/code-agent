// ============================================================================
// Research Mode Runners - Deep research and semantic research execution
// ============================================================================

import type { AgentEvent, Message, ModelConfig } from '../../../shared/types';
import type { ReportStyle, ResearchUserSettings } from '../../research/types';
import { DeepResearchMode, SemanticResearchOrchestrator } from '../../research';
import { ModelRouter } from '../../model/modelRouter';
import type { ToolExecutor } from '../../tools/toolExecutor';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ResearchRunner');

export interface ResearchRunnerDeps {
  toolExecutor: ToolExecutor;
  generateId: () => string;
  addMessage: (message: Message) => void;
}

/**
 * 运行深度研究模式
 * @returns DeepResearchMode instance (caller should store for cancel support)
 */
export async function runDeepResearch(
  topic: string,
  reportStyle: ReportStyle | undefined,
  onEvent: (event: AgentEvent) => void,
  modelConfig: ModelConfig,
  deps: ResearchRunnerDeps
): Promise<void> {
  logger.info('========== Starting deep research mode ==========');
  logger.info('Topic:', topic);
  logger.info('Report style:', reportStyle);

  const modelRouter = new ModelRouter();

  const deepResearchMode = new DeepResearchMode({
    modelRouter,
    toolExecutor: deps.toolExecutor,
    onEvent,
  });

  try {
    const result = await deepResearchMode.run(topic, reportStyle ?? 'default');

    if (result.success && result.report) {
      const reportMessage: Message = {
        id: deps.generateId(),
        role: 'assistant',
        content: result.report.content,
        timestamp: Date.now(),
      };
      deps.addMessage(reportMessage);

      onEvent({
        type: 'message',
        data: reportMessage,
      });
    }

    logger.info('========== Deep research completed ==========');
    logger.info('Success:', result.success);
    logger.info('Duration:', result.duration, 'ms');
  } catch (error) {
    logger.error('========== Deep research EXCEPTION ==========');
    logger.error('Error:', error);
    onEvent({
      type: 'error',
      data: {
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  } finally {
    onEvent({ type: 'agent_complete', data: null });
  }
}

/**
 * 检查并运行语义研究模式
 * @returns true if research was triggered and completed
 */
export async function checkAndRunSemanticResearch(
  content: string,
  reportStyle: ReportStyle | undefined,
  onEvent: (event: AgentEvent) => void,
  modelConfig: ModelConfig,
  deps: ResearchRunnerDeps,
  userSettings: Partial<ResearchUserSettings>,
  sessionId?: string
): Promise<boolean> {
  const modelRouter = new ModelRouter();

  const orchestrator = new SemanticResearchOrchestrator({
    modelRouter,
    toolExecutor: deps.toolExecutor,
    onEvent,
    userSettings,
  });

  try {
    const result = await orchestrator.run(
      content,
      false,
      reportStyle
    );

    if (result.researchTriggered && result.success && result.report) {
      const reportMessage: Message = {
        id: deps.generateId(),
        role: 'assistant',
        content: result.report.content,
        timestamp: Date.now(),
      };
      deps.addMessage(reportMessage);

      onEvent({
        type: 'message',
        data: reportMessage,
      });

      logger.info('Semantic research completed:', {
        duration: result.duration,
        intent: result.classification?.intent,
      });

      onEvent({ type: 'agent_complete', data: null });
      return true;
    }

    if (result.researchTriggered && !result.success) {
      logger.warn('Semantic research failed:', result.error);
    }

    return false;
  } catch (error) {
    logger.error('Semantic research exception:', error);
    return false;
  }
}
