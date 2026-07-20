// ============================================================================
// Auto Agent Runner - Dynamic multi-agent execution
// ============================================================================

import type { AgentEvent, Message, ModelConfig } from '../../../shared/contract';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '../../../shared/contract/conversationEnvelope';
import { getAutoAgentCoordinator } from '../autoAgentCoordinator';
import { getDynamicAgentFactory } from '../dynamicAgentFactory';
import { getAgentRequirementsAnalyzer } from '../agentRequirementsAnalyzer';
import { getSessionManager } from '../../services';
import { TaskDAG } from '../../scheduler/TaskDAG';
import { sendDAGInitEvent } from '../../scheduler/dagEventBridge';
import { getToolResolver } from '../../tools/dispatch/toolResolver';
import type { TaskListManager } from '../taskList';
import { createLogger } from '../../services/infra/logger';
import { getActiveRunTraceContext } from '../../telemetry/runTraceContext';
import { GraphEventCompatibilityAdapter } from '../../orchestration/graphEventCompatibilityAdapter';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getAutoAgentDurableRuntime } from '../autoAgentDurableRuntime';

const logger = createLogger('AutoAgentRunner');

export interface AutoAgentRunnerDeps {
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
    sessionId?: string,
    executionContent?: string,
    toolScope?: WorkbenchToolScope,
    executionIntent?: ConversationExecutionIntent,
  ) => Promise<void>;
  toolScope?: WorkbenchToolScope;
  executionIntent?: ConversationExecutionIntent;
  sourceMessageId?: string;
}

/**
 * 运行自动 Agent 模式
 */
export async function runAutoAgentMode(
  content: string,
  executionContent: string,
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
    userMessage: executionContent,
    workingDirectory: deps.workingDirectory,
    sessionId,
  });

  if (agents.length === 0) {
    logger.warn('No auto agents generated, falling back to standard loop');
    await deps.runStandardAgentLoop(
      content,
      onEvent,
      modelConfig,
      sessionId,
      executionContent,
      deps.toolScope,
      deps.executionIntent,
    );
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
    } catch {
      logger.info('[TaskList] Approval rejected or reset');
      onEvent({ type: 'agent_complete', data: null });
      return;
    }
  }

  // Execute agents through coordinator
  const coordinator = getAutoAgentCoordinator();
  const traceContext = getActiveRunTraceContext();
  const durableRuntime = getAutoAgentDurableRuntime();
  const canonicalWorkspace = path.resolve(deps.workingDirectory);
  const durableController = durableRuntime && traceContext && deps.sourceMessageId
    ? await durableRuntime.start({
        parentRunId: traceContext.runId,
        sessionId: sessionId || 'unknown',
        sourceMessageId: deps.sourceMessageId,
        workspace: {
          root: canonicalWorkspace,
          cwd: canonicalWorkspace,
          fingerprint: createHash('sha256').update(canonicalWorkspace).digest('hex'),
        },
        graphId: `auto-agent:${sessionId || 'unknown'}`,
        sideEffect: agents.some((agent) => agent.tools.some((tool) => /(write|edit|bash|shell|browser|computer)/i.test(tool))),
      })
    : null;
  const toolResolver = getToolResolver();
  const compatibility = new GraphEventCompatibilityAdapter({
    agent: (event) => { if (event.type !== 'agent_thinking') onEvent(event); },
    graph: (event) => {
      if (!event.nodeId || !event.nodeStatus) return;
      const status = event.type === 'node_queued' ? 'pending'
        : event.type === 'node_started' ? 'running'
          : event.type === 'node_completed' ? 'completed'
            : event.type === 'node_cancelled' ? 'cancelled'
              : event.type === 'node_failed' || event.type === 'node_skipped' ? 'failed' : undefined;
      if (!status) return;
      deps.sendDAGStatusEvent(dagId, event.nodeId, status);
      const matchingTask = taskItems.find(t => t.subject === event.nodeId || t.description?.includes(event.nodeId!));
      if (matchingTask) {
        if (status === 'running') taskListManager.startExecution(matchingTask.id);
        else if (status === 'completed') taskListManager.completeExecution(matchingTask.id, `Agent ${event.nodeId} completed`);
        else if (status === 'failed') taskListManager.failExecution(matchingTask.id, `Agent ${event.nodeId} failed`);
      }
      onEvent({
        type: 'agent_thinking',
        data: { message: `Agent ${event.nodeId}: ${status}`, agentId: event.nodeId },
      });
    },
    diagnostic: (error, event, target) => logger.warn('Auto Agent compatibility projection failed', {
      error: error instanceof Error ? error.message : String(error), graphId: event.graphId, target,
    }),
  }, { deferTerminals: true });

  let result;
  try {
    result = await coordinator.execute(agents, requirements, {
      sessionId: sessionId || 'unknown',
      executionContext: {
      runId: durableController?.runId ?? traceContext?.runId ?? `auto:${sessionId || 'unknown'}`,
      sessionId: sessionId || 'unknown',
      workspace: deps.workingDirectory,
      cwd: deps.workingDirectory,
      modelConfig,
      resolver: toolResolver,
      permission: { request: async () => true },
      events: { emit: (type, data) => onEvent({ type, data } as AgentEvent) },
      abortSignal: new AbortController().signal,
      traceContext,
      toolScope: deps.toolScope,
      executionIntent: deps.executionIntent,
    },
      compatibilitySink: compatibility,
      onGraphCheckpoint: (checkpoint) => durableController?.persist(checkpoint),
    });
    await durableController?.terminal(result.success ? 'completed' : 'failed', result.success ? undefined : 'auto_agent_failed');
  } catch (error) {
    await durableController?.terminal('failed', error instanceof Error ? error.message : 'auto_agent_failed').catch(() => undefined);
    throw error;
  }

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

  await compatibility.flushTerminals();
}
