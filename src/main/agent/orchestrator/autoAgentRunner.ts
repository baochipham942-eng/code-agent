// ============================================================================
// Auto Agent Runner - Dynamic multi-agent execution
// ============================================================================

import type { AgentEvent, Message, ModelConfig } from '../../../shared/contract';
import { getAutoAgentCoordinator } from '../autoAgentCoordinator';
import { getDynamicAgentFactory } from '../dynamicAgentFactory';
import { getAgentRequirementsAnalyzer } from '../agentRequirementsAnalyzer';
import { getSessionManager } from '../../services';
import { TaskDAG } from '../../scheduler/TaskDAG';
import { sendDAGInitEvent } from '../../scheduler/dagEventBridge';
import type { ToolRegistry, Tool } from '../../tools/toolRegistry';
import type { TaskListManager } from '../taskList';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AutoAgentRunner');

export interface AutoAgentRunnerDeps {
  toolRegistry: ToolRegistry;
  workingDirectory: string;
  sessionId: string | null;
  taskListManager: TaskListManager;
  generateId: () => string;
  addMessage: (message: Message) => void;
  sendDAGStatusEvent: (dagId: string, agentId: string, status: string) => void;
  runStandardAgentLoop: (
    content: string,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    sessionId?: string
  ) => Promise<void>;
}

/**
 * 运行自动 Agent 模式
 */
export async function runAutoAgentMode(
  content: string,
  requirements: Awaited<ReturnType<ReturnType<typeof getAgentRequirementsAnalyzer>['analyze']>>,
  onEvent: (event: AgentEvent) => void,
  modelConfig: ModelConfig,
  deps: AutoAgentRunnerDeps,
  sessionId?: string
): Promise<void> {
  logger.info('========== Starting auto agent mode ==========');
  logger.info('Task type:', requirements.taskType);
  logger.info('Execution strategy:', requirements.executionStrategy);
  logger.info('Confidence:', requirements.confidence);

  // Create dynamic agents
  const factory = getDynamicAgentFactory();
  const agents = factory.create(requirements, {
    userMessage: content,
    workingDirectory: deps.workingDirectory,
    sessionId,
  });

  if (agents.length === 0) {
    logger.warn('No auto agents generated, falling back to standard loop');
    await deps.runStandardAgentLoop(content, onEvent, modelConfig, sessionId);
    return;
  }

  // Create DAG for multi-agent visualization
  const dagId = `auto-${sessionId || Date.now()}`;
  const dag = new TaskDAG(dagId, `自动 Agent: ${requirements.taskType}`);

  // Add task for each agent
  const agentDependencies: string[] = [];
  for (const agent of agents) {
    dag.addAgentTask(agent.id, {
      role: agent.name,
      prompt: agent.systemPrompt.substring(0, 200),
    }, {
      name: agent.name,
      description: `工具: ${agent.tools.slice(0, 3).join(', ')}${agent.tools.length > 3 ? '...' : ''}`,
      dependencies: requirements.executionStrategy === 'sequential' ? agentDependencies.slice(-1) : [],
    });
    agentDependencies.push(agent.id);
  }

  // Send DAG init event for visualization
  sendDAGInitEvent(dag);

  // Notify UI about auto agent planning
  onEvent({
    type: 'agent_thinking',
    data: {
      message: `正在规划自动 Agent 执行...\n任务类型: ${requirements.taskType}\n策略: ${requirements.executionStrategy}\nAgent 数量: ${agents.length}`,
    },
  });

  // === TaskList Integration: 写入任务列表 ===
  const taskListManager = deps.taskListManager;
  taskListManager.reset();
  const taskItems = agents.map((agent, idx) => {
    return taskListManager.createTask({
      subject: agent.name,
      description: agent.systemPrompt?.substring(0, 200) || `Execute ${agent.name}`,
      assignee: agent.name,
      priority: idx === 0 ? 1 : 3,
      dependencies: requirements.executionStrategy === 'sequential' && idx > 0
        ? [agents[idx - 1].id]
        : [],
    });
  });

  // 如果需要审批，等待用户确认
  if (taskListManager.getState().requireApproval) {
    logger.info('[TaskList] Waiting for user approval before execution...');
    onEvent({
      type: 'notification',
      data: { message: '任务列表已生成，等待审批...' },
    });
    try {
      await Promise.all(taskItems.map(t => taskListManager.waitForApproval(t.id)));
    } catch (error) {
      logger.info('[TaskList] Approval rejected or reset');
      onEvent({ type: 'agent_complete', data: null });
      return;
    }
  }

  // Execute agents through coordinator
  const coordinator = getAutoAgentCoordinator();
  const toolMap = new Map<string, Tool>();
  for (const tool of deps.toolRegistry.getAllTools()) {
    toolMap.set(tool.name, tool);
  }

  const result = await coordinator.execute(agents, requirements, {
    sessionId: sessionId || 'unknown',
    modelConfig,
    toolRegistry: toolMap,
    toolContext: {
      workingDirectory: deps.workingDirectory,
      requestPermission: async () => true,
    },
    onProgress: (agentId, status, progress) => {
      // Sync DAG task status
      deps.sendDAGStatusEvent(dagId, agentId, status);

      // === TaskList Integration: 同步任务状态 ===
      const matchingTask = taskItems.find(t => t.subject === agentId || t.description?.includes(agentId));
      if (matchingTask) {
        if (status === 'running') {
          taskListManager.startExecution(matchingTask.id);
        } else if (status === 'completed') {
          taskListManager.completeExecution(matchingTask.id, `Agent ${agentId} completed`);
        } else if (status === 'failed') {
          taskListManager.failExecution(matchingTask.id, `Agent ${agentId} failed`);
        }
      }

      onEvent({
        type: 'agent_thinking',
        data: {
          message: `Agent ${agentId}: ${status}${progress !== undefined ? ` (${progress}%)` : ''}`,
          agentId,
          progress,
        },
      });
    },
  });

  // Process result
  if (result.success && result.aggregatedOutput) {
    const assistantMessage: Message = {
      id: deps.generateId(),
      role: 'assistant',
      content: result.aggregatedOutput,
      timestamp: Date.now(),
    };
    deps.addMessage(assistantMessage);

    // Save message
    const sessionManager = getSessionManager();
    try {
      if (deps.sessionId) {
        await sessionManager.addMessageToSession(deps.sessionId, assistantMessage);
      } else {
        await sessionManager.addMessage(assistantMessage);
      }
    } catch (error) {
      logger.error('Failed to save auto agent result:', error);
    }

    onEvent({
      type: 'message',
      data: assistantMessage,
    });
  }

  // Log summary
  logger.info('========== Auto agent mode completed ==========');
  logger.info('Success:', result.success);
  logger.info('Total iterations:', result.totalIterations);
  logger.info('Total cost:', result.totalCost);
  if (result.errors.length > 0) {
    logger.warn('Errors:', result.errors);
  }

  // Emit completion
  onEvent({ type: 'agent_complete', data: null });
}
