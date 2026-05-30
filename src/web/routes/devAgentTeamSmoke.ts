import { Router } from 'express';
import type { Response } from 'express';
import type { ModelConfig, ToolDefinition } from '../../shared/contract';
import type { AgentTask, AgentTaskResult, ParallelExecutionResult } from '../../main/agent/parallelAgentCoordinator';
import { getSwarmServices } from '../../main/agent/swarmServices';
import type { ToolResolver } from '../../main/tools/dispatch/toolResolver';
import type { ToolContext } from '../../main/tools/types';
import { formatError } from '../helpers/utils';
import type { WebRouteLogger } from './routeTypes';

interface DevAgentTeamSmokeDeps {
  isEnabled: (env?: NodeJS.ProcessEnv) => boolean;
  logger: WebRouteLogger;
}

interface SmokeScenarioSummary {
  success: boolean;
  results: Array<{
    taskId: string;
    success: boolean;
    blocked: boolean;
    cancelled: boolean;
    error?: string;
    output?: string;
  }>;
  errors: Array<{ taskId: string; error: string }>;
}

function ensureDevApiEnabled(res: Response, deps: DevAgentTeamSmokeDeps): boolean {
  if (deps.isEnabled()) return true;
  res.status(404).json({ error: 'Dev API is not available in production mode.' });
  return false;
}

function taskSummary(result: AgentTaskResult): SmokeScenarioSummary['results'][number] {
  return {
    taskId: result.taskId,
    success: result.success,
    blocked: Boolean(result.blocked),
    cancelled: Boolean(result.cancelled),
    error: result.error,
    output: result.output,
  };
}

function summarizeResult(result: ParallelExecutionResult): SmokeScenarioSummary {
  return {
    success: result.success,
    results: result.results.map(taskSummary),
    errors: result.errors,
  };
}

function getTask(result: ParallelExecutionResult, taskId: string): AgentTaskResult {
  const task = result.results.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    throw new Error(`Missing task result: ${taskId}`);
  }
  return task;
}

function makeToolResolver(): ToolResolver {
  return {
    getDefinition(name: string): ToolDefinition {
      return {
        name,
        description: `E2E dev smoke tool definition for ${name}`,
        inputSchema: { type: 'object', properties: {} },
        permissionLevel: 'read',
        requiresPermission: false,
      };
    },
  } as unknown as ToolResolver;
}

function makeToolContext(sessionId: string, signal?: AbortSignal): ToolContext {
  const resolver = makeToolResolver();
  return {
    workingDirectory: process.cwd(),
    requestPermission: async () => true,
    abortSignal: signal,
    currentToolCallId: `${sessionId}-agent-team-smoke`,
    sessionId,
    resolver,
  };
}

function initializeCoordinator(sessionId: string, signal?: AbortSignal): void {
  const coordinator = getSwarmServices().parallelCoordinator;
  coordinator.reset();
  coordinator.initialize({
    modelConfig: { provider: 'acceptance', model: 'e2e-local-subagent' } as ModelConfig,
    toolResolver: makeToolResolver(),
    toolContext: makeToolContext(sessionId, signal),
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Agent Team smoke condition.');
}

async function runDependencySmoke(sessionId: string): Promise<SmokeScenarioSummary> {
  const coordinator = getSwarmServices().parallelCoordinator;
  initializeCoordinator(`${sessionId}-dependency`);
  const result = await coordinator.executeParallel([
    { id: 'dep-root', role: 'scout', task: 'E2E_FAIL upstream dependency', tools: [] },
    { id: 'dep-child', role: 'editor', task: 'must not start after upstream failure', tools: [], dependsOn: ['dep-root'] },
  ]);
  const root = getTask(result, 'dep-root');
  const child = getTask(result, 'dep-child');
  if (root.success || !child.blocked || !child.error?.includes('failed dependencies')) {
    throw new Error(`Dependency gate smoke failed: ${JSON.stringify(summarizeResult(result))}`);
  }
  return summarizeResult(result);
}

async function runMessageSmoke(sessionId: string): Promise<SmokeScenarioSummary & { sent: boolean; deliveredMessage: string }> {
  const coordinator = getSwarmServices().parallelCoordinator;
  const deliveredMessage = 'hello from parent during app-host smoke';
  initializeCoordinator(`${sessionId}-message`);
  const run = coordinator.executeParallel([
    { id: 'message-agent', role: 'scout', task: 'wait for a queued parent message', tools: [] },
  ]);
  await waitUntil(() => coordinator.canReceiveMessage('message-agent'));
  const sent = coordinator.sendMessage('message-agent', deliveredMessage);
  const result = await run;
  const task = getTask(result, 'message-agent');
  if (!sent || !task.success || !task.output.includes(deliveredMessage)) {
    throw new Error(`Message queue smoke failed: ${JSON.stringify({ sent, result: summarizeResult(result) })}`);
  }
  return { ...summarizeResult(result), sent, deliveredMessage };
}

async function runCancelSmoke(sessionId: string): Promise<SmokeScenarioSummary> {
  const coordinator = getSwarmServices().parallelCoordinator;
  initializeCoordinator(`${sessionId}-cancel`);
  const run = coordinator.executeParallel([
    { id: 'cancel-running', role: 'scout', task: 'slow task that should be cancelled', tools: [] },
    { id: 'cancel-pending', role: 'editor', task: 'pending task that must not start', tools: [], dependsOn: ['cancel-running'] },
  ]);
  await waitUntil(() => coordinator.getRunningTasks().includes('cancel-running'));
  coordinator.abortAllRunning('swarm_cancelled');
  const result = await run;
  const running = getTask(result, 'cancel-running');
  const pending = getTask(result, 'cancel-pending');
  if (!running.cancelled || !pending.cancelled) {
    throw new Error(`Run-level cancel smoke failed: ${JSON.stringify(summarizeResult(result))}`);
  }
  return summarizeResult(result);
}

async function runAgentTeamSmoke(): Promise<{
  ok: true;
  sessionId: string;
  dependency: SmokeScenarioSummary;
  message: SmokeScenarioSummary & { sent: boolean; deliveredMessage: string };
  cancel: SmokeScenarioSummary;
}> {
  const sessionId = `agent-team-smoke-${Date.now()}`;
  const dependency = await runDependencySmoke(sessionId);
  const message = await runMessageSmoke(sessionId);
  const cancel = await runCancelSmoke(sessionId);
  getSwarmServices().parallelCoordinator.reset();
  return {
    ok: true,
    sessionId,
    dependency,
    message,
    cancel,
  };
}

export function createDevAgentTeamSmokeRouter(deps: DevAgentTeamSmokeDeps): Router {
  const router = Router();

  router.post('/', async (_req, res) => {
    if (!ensureDevApiEnabled(res, deps)) return;
    if (process.env.CODE_AGENT_E2E_LOCAL_SUBAGENT_EXECUTOR !== '1') {
      res.status(409).json({
        ok: false,
        error: 'CODE_AGENT_E2E_LOCAL_SUBAGENT_EXECUTOR=1 is required for deterministic Agent Team smoke.',
      });
      return;
    }

    try {
      res.json(await runAgentTeamSmoke());
    } catch (error) {
      deps.logger.error('Dev Agent Team smoke failed', error);
      try {
        getSwarmServices().parallelCoordinator.reset();
      } catch {
        // Ignore cleanup errors after a failed dev-only smoke.
      }
      res.status(500).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  return router;
}
