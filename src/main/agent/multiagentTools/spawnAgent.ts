// ============================================================================
// Spawn Agent Tool - Create specialized sub-agents
// Gen 7: Multi-Agent capability
// Enhanced with parallel execution support
// Refactored: Uses unified 4-layer agent types
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../../tools/types';
import type { ModelConfig } from '../../../shared/contract';
import type { FullAgentConfig } from '../../../shared/contract/agentTypes';
import { getSubagentExecutor } from '../subagentExecutor';
import type { ToolResolver } from '../../tools/dispatch/toolResolver';
import {
  getParallelAgentCoordinator,
  type AgentTask,
} from '../parallelAgentCoordinator';
import {
  getPredefinedAgent,
  listPredefinedAgents,
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
  getAgentPermissionPreset,
  getAgentMaxBudget,
} from '../agentDefinition';
import { SUBAGENT_SUFFIXES, type CoreAgentId, isCoreAgent } from '../hybrid/coreAgents';
import {
  SubagentContextBuilder,
  getAgentContextLevel,
} from '../subagentContextBuilder';
import { getSwarmEventEmitter } from '../swarmEventPublisher';
import { getSpawnGuard } from '../spawnGuard';
import { getSwarmLaunchApprovalGate } from '../swarmLaunchApproval';
import { createAgentWorktree, cleanupAgentWorktree, cleanupOrphanedWorktrees } from '../agentWorktree';
import { aggregateTeamResults } from '../resultAggregator';
import { shouldUseForkMode, buildForkContexts, applyCacheControl } from '../forkContext.js';
import { validateNoCycles, detectCycles } from '../taskDag.js';
import {
  shouldActivateCoordinator,
  createCoordinatorSession,
} from '../coordinatorMode';

// Role-based default isolation: coder agents get worktree isolation by default
const DEFAULT_ISOLATION: Record<string, 'worktree' | 'none'> = {
  coder: 'worktree',
  explorer: 'none',
  reviewer: 'none',
  planner: 'none',
  awaiter: 'none',
};

export const spawnAgentTool: Tool = {
  name: 'spawn_agent',
  description: `Launch a sub-agent for a focused task. Sub-agents run in isolated sessions with their own context window and return only their final result to you.

## When to spawn (autonomous judgment)
Consider spawning sub-agents when:
- Task involves 3+ unrelated files/modules (parallel exploration)
- Need simultaneous coding and testing/review
- Need codebase research before modification (explorer → coder pipeline)
- Refactoring with multiple independent change points
- Broad exploration that would consume your context window

When NOT to spawn:
- Simple single-file reads — use read_file directly
- Searching for a specific definition — use glob/grep directly
- Quick config changes or information queries
- Urgent blocking work where you need the result immediately

## Delegation strategy
1. Plan first: analyze the task, identify critical path vs side-quests
2. Keep blocking work local — only delegate non-blocking parallel tasks
3. Subtasks must be concrete, self-contained, and non-overlapping
4. For code edits, assign disjoint file ownership per agent
5. Tell workers they are not alone — don't revert others' changes

## After delegation
- Minimize waiting — do meaningful non-overlapping work while agents run
- Don't redo what a sub-agent already did
- Review returned changes, then integrate or refine

## Parallel patterns
- Spawn multiple explorers in parallel for independent codebase questions
- Split implementation into disjoint file scopes for parallel workers
- Run reviewer in parallel with ongoing implementation

## Available roles
- explorer: Read-only codebase exploration. Fast and authoritative. Spawn multiple in parallel for independent questions. Trust their results without re-verification.
- coder: Implementation work. Assign file ownership explicitly. Tell coders they are not alone in the codebase.
- reviewer: Code review and quality checks. Read-only.
- planner: Architecture design and task decomposition. Full context.
- awaiter: Long-running command monitor (tests, builds, deploys). Uses fast model, high iteration limit. Spawn in background and continue other work.

## Parameters
- role: Agent role (explorer/coder/reviewer/planner or custom name)
- task: Concrete task description (be specific and self-contained)
- parallel: Set true + agents array for multiple agents with dependencies
- waitForCompletion: false to run in background (default true)
- forkContext: true to inherit parent conversation history
- isolation: "worktree" to give coder agent an isolated git branch (auto-cleanup if no changes)`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        description: 'The role/ID of the agent (built-in or predefined)',
      },
      task: {
        type: 'string',
        description: 'The task for the agent to complete',
      },
      customPrompt: {
        type: 'string',
        description: 'Custom system prompt (overrides role default, enables dynamic mode)',
      },
      customTools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Custom tool list for dynamic agents',
      },
      maxBudget: {
        type: 'number',
        description: 'Maximum budget in USD for this agent',
      },
      waitForCompletion: {
        type: 'boolean',
        description: 'Wait for agent to complete before returning',
      },
      maxIterations: {
        type: 'number',
        description: 'Maximum iterations for the agent (default: 20)',
      },
      forkContext: {
        type: 'boolean',
        description: 'When true, fork parent conversation history to the sub-agent. Use when the sub-agent needs full prior context (e.g. coder tasks that depend on earlier discussion).',
      },
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description: 'Isolation mode. "worktree" creates a git worktree so the agent works on an isolated branch. Best for coder agents doing file edits in parallel. Auto-cleanup if no changes.',
      },
      parallel: {
        type: 'boolean',
        description: 'Enable parallel execution mode',
      },
      agents: {
        type: 'array',
        description: 'Array of agents for parallel execution',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            task: { type: 'string' },
            maxBudget: { type: 'number' },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of agents this one depends on',
            },
          },
          required: ['role', 'task'],
        },
      },
    },
    required: [],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const parallel = params.parallel as boolean | undefined;
    const agents = params.agents as Array<{ role: string; task: string; maxBudget?: number; dependsOn?: string[] }> | undefined;

    // Check for required context
    if (!context.modelConfig) {
      return {
        success: false,
        error: 'spawn_agent requires modelConfig in context',
      };
    }

    // Handle parallel execution mode
    if (parallel && agents && agents.length > 0) {
      return executeParallelAgents(agents, context);
    }

    // Single agent mode
    const role = params.role as string;
    const task = params.task as string;
    const customPrompt = params.customPrompt as string | undefined;
    const customTools = params.customTools as string[] | undefined;
    const maxBudget = params.maxBudget as number | undefined;
    const waitForCompletion = params.waitForCompletion !== false;
    const maxIterations = (params.maxIterations as number) || 20;

    // Validate required params for single agent
    if (!task) {
      return {
        success: false,
        error: 'Task is required. Provide role+task for predefined agent or customPrompt+task for dynamic agent.',
      };
    }

    // Determine agent mode: declarative (predefined) or dynamic
    const isDynamicMode = customPrompt && !role;
    let agentConfig: FullAgentConfig | undefined;
    let agentName: string;
    let systemPrompt: string;
    let tools: string[];

    if (isDynamicMode) {
      // Dynamic mode: use customPrompt and customTools
      agentName = 'Dynamic Agent';
      systemPrompt = customPrompt!;
      tools = customTools || ['read_file', 'glob', 'grep']; // Default read-only tools for safety
    } else {
      // Declarative mode: resolve from predefined agents
      if (!role) {
        return {
          success: false,
          error: 'Either provide role (for predefined agent) or customPrompt (for dynamic agent)',
        };
      }

      agentConfig = getPredefinedAgent(role);
      if (!agentConfig) {
        const availableIds = listPredefinedAgents().map(a => a.id);
        return {
          success: false,
          error: `Unknown agent: ${role}. Available agents: ${availableIds.join(', ')}`,
        };
      }

      agentName = agentConfig.name;
      systemPrompt = customPrompt || getAgentPrompt(agentConfig);
      tools = customTools || getAgentTools(agentConfig);
    }

    // ========================================================================
    // Phase 1: Subagent suffix 注入（借鉴 Cline + Codex 行为规范）
    // ========================================================================
    if (role && isCoreAgent(role) && !customPrompt) {
      const suffix = SUBAGENT_SUFFIXES[role as CoreAgentId];
      if (suffix) {
        systemPrompt += suffix;
      }
    }

    // 根据 task 内容过滤文档工具 — 代码任务不需要 read_pdf/read_docx/read_xlsx
    {
      const DOCUMENT_TOOLS = ['read_pdf', 'read_docx', 'read_xlsx'];
      const taskLower = task.toLowerCase();
      const needsDocTools = DOCUMENT_TOOLS.some(t => taskLower.includes(t))
        || /\.(pdf|docx|xlsx|doc|xls)\b/.test(taskLower);
      if (!needsDocTools) {
        tools = tools.filter(t => !DOCUMENT_TOOLS.includes(t));
      }
    }

    // ========================================================================
    // Phase 0: Subagent 上下文注入
    // ========================================================================
    // 借鉴 Claude Code: "Agents with access to current context can see the
    // full conversation history before the tool call"
    const forkContext = params.forkContext as boolean | undefined;
    try {
      // forkContext=true 时强制使用 full 上下文级别
      const contextLevel = forkContext
        ? 'full' as const
        : (context.contextLevel || (role ? getAgentContextLevel(role) : 'relevant'));

      // 只有在有足够上下文信息时才注入
      if (context.messages && context.messages.length > 0) {
        const contextBuilder = new SubagentContextBuilder({
          sessionId: context.sessionId || 'unknown',
          messages: context.messages,
          contextLevel,
          todos: context.todos,
          modifiedFiles: context.modifiedFiles,
        });

        const subagentContext = await contextBuilder.build(task);
        const contextPrompt = contextBuilder.formatForSystemPrompt(subagentContext);

        if (contextPrompt) {
          systemPrompt = systemPrompt + contextPrompt;
        }

        // forkContext=true 时追加 fork 前缀提示（借鉴 Codex CLI）
        if (forkContext) {
          systemPrompt += `\n\n---\n# Fork Context\nYou are a newly spawned agent. The prior conversation history was forked from your parent agent. Treat the next user message as your new task, and use the forked history only as background context.`;
        }
      }
    } catch (err) {
      // 上下文注入失败不应阻止任务执行
      console.warn('[SpawnAgent] Failed to inject subagent context:', err);
    }

    // Generate agent ID
    const agentId = `agent_${role || 'dynamic'}_${Date.now()}`;

    // Defensive check: ensure sessionId is available for task tool sharing
    if (!context.sessionId) {
      console.warn('[SpawnAgent] No sessionId in context — subagent task tools will use isolated session');
    }

    // ========================================================================
    // SpawnGuard: 并发检查 + 工具过滤
    // ========================================================================
    const guard = getSpawnGuard();

    if (!guard.canSpawn()) {
      return {
        success: false,
        error: `Cannot spawn agent: at capacity (${guard.getRunningCount()} running). Wait for existing agents to complete or use close_agent to free slots.`,
      };
    }

    // 过滤子代理禁用工具（子不启子、不问用户等）
    // P3: explorer/reviewer 额外禁用写工具（工具层面强制 readonly）
    const READONLY_ROLES = ['explorer', 'explore', 'reviewer'];
    const isReadonlyRole = role && READONLY_ROLES.includes(role.toLowerCase());
    const disabledTools = isReadonlyRole
      ? guard.getReadonlyDisabledTools()
      : guard.getDisabledTools();
    tools = tools.filter(t => !disabledTools.includes(t));

    try {
      const executor = getSubagentExecutor();

      // Determine permission preset based on agent config
      const permissionPreset = agentConfig
        ? getAgentPermissionPreset(agentConfig)
        : 'development';

      // Determine max budget (use agent-specific or inherited)
      const effectiveMaxBudget = maxBudget || (agentConfig ? getAgentMaxBudget(agentConfig) : undefined);

      // 注入工作目录到 task，避免子 Agent 使用相对路径
      let cwd = context.workingDirectory || process.cwd();

      // Best-effort orphan cleanup before creating new worktrees
      cleanupOrphanedWorktrees(cwd).catch(() => {});

      // Worktree isolation: explicit param > role-based default > none
      const effectiveIsolation = (params.isolation as string | undefined)
        ?? DEFAULT_ISOLATION[role || '']
        ?? 'none';
      let worktreeInfo: { worktreePath: string; branchName: string } | undefined;
      if (effectiveIsolation === 'worktree') {
        try {
          worktreeInfo = await createAgentWorktree(agentId, cwd);
          cwd = worktreeInfo.worktreePath;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Unknown error';
          return {
            success: false,
            error: `Failed to create worktree for agent: ${errMsg}. Ensure you are in a git repository.`,
          };
        }
      }

      const enrichedTask = `[工作目录: ${cwd}] 所有文件路径基于此目录。\n\n${task}`;

      // Create AbortController for this agent
      const abortController = new AbortController();

      // Build executor context
      const executorContext = {
        modelConfig: context.modelConfig as ModelConfig,
        toolResolver: context.resolver as ToolResolver,
        toolContext: context,
        parentToolUseId: context.currentToolCallId,
        abortSignal: abortController.signal,
        spawnGuardId: agentId,
        executionAgentId: agentId,
        worktreePath: worktreeInfo?.worktreePath,
        hookManager: context.hookManager,
      };

      const executorConfig = {
        name: agentName,
        systemPrompt,
        availableTools: tools,
        maxIterations,
        permissionPreset,
        maxBudget: effectiveMaxBudget,
      };

      if (waitForCompletion) {
        // Execute and wait for result
        const promise = executor.execute(enrichedTask, executorConfig, executorContext);

        // Register with SpawnGuard
        guard.register(agentId, role || 'dynamic', task, promise, abortController);

        const result = await promise;

        // Worktree cleanup: check for changes and cleanup or preserve
        let worktreeNote = '';
        if (worktreeInfo) {
          const repoPath = context.workingDirectory || process.cwd();
          const cleanup = await cleanupAgentWorktree(agentId, worktreeInfo.worktreePath, repoPath);
          if (cleanup.hasChanges) {
            worktreeNote = `\n- Worktree: preserved at ${cleanup.worktreePath} (branch: ${cleanup.branchName}) — review and merge changes`;
          } else {
            worktreeNote = '\n- Worktree: auto-cleaned (no changes)';
          }
        }

        if (result.success) {
          return {
            success: true,
            output: `Agent [${agentName}] completed task:

Task: ${task}

Result:
${result.output}

Stats:
- Iterations: ${result.iterations}
- Tools used: ${result.toolsUsed.join(', ') || 'none'}
- Agent ID: ${agentId}
- Pipeline ID: ${result.agentId || 'N/A'}${result.cost !== undefined ? `\n- Cost: $${result.cost.toFixed(4)}` : ''}${worktreeNote}`,
          };
        } else {
          return {
            success: false,
            error: `Agent [${agentName}] failed: ${result.error}${worktreeNote}`,
            output: result.output,
          };
        }
      } else {
        // Start agent in background
        const promise = executor.execute(enrichedTask, executorConfig, executorContext);

        // Register with SpawnGuard (auto-tracks completion)
        guard.register(agentId, role || 'dynamic', task, promise, abortController);

        // Background worktree cleanup: register onComplete callback
        if (worktreeInfo) {
          const repoPath = context.workingDirectory || process.cwd();
          const wt = worktreeInfo;
          guard.onComplete(async (completedAgent) => {
            if (completedAgent.id === agentId) {
              await cleanupAgentWorktree(agentId, wt.worktreePath, repoPath);
            }
          });
        }

        const isolationNote = worktreeInfo
          ? `\n- Isolation: worktree (branch: ${worktreeInfo.branchName}, path: ${worktreeInfo.worktreePath})`
          : '';

        return {
          success: true,
          output: `Agent [${agentName}] spawned in background:
- Agent ID: ${agentId}
- Task: ${task}
- Status: running
- Mode: ${isDynamicMode ? 'dynamic' : 'declarative'}
- Running agents: ${guard.getRunningCount()}${isolationNote}

Use wait_agent to block until done, or close_agent to cancel.`,
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Failed to spawn agent: ${errorMsg}`,
      };
    }
  },
};

/**
 * Backward-compatible type for spawned agent status.
 */
export interface SpawnedAgent {
  id: string;
  role: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  task?: string;
  result?: string;
  error?: string;
}

// Export function to get agent status (used by agent_message tool)
export function getSpawnedAgent(agentId: string): SpawnedAgent | undefined {
  const guard = getSpawnGuard();
  const managed = guard.get(agentId);
  if (!managed) return undefined;
  return {
    id: managed.id,
    role: managed.role,
    status: managed.status === 'cancelled' ? 'failed' : managed.status,
    task: managed.task,
    result: managed.result?.output,
    error: managed.error,
  };
}

// Export function to list all agents
export function listSpawnedAgents(): SpawnedAgent[] {
  const guard = getSpawnGuard();
  return guard.list().map(managed => ({
    id: managed.id,
    role: managed.role,
    status: managed.status === 'cancelled' ? 'failed' as const : managed.status,
    task: managed.task,
    result: managed.result?.output,
    error: managed.error,
  }));
}

// Export available agents
export function getAvailableAgents(): Array<{ id: string; name: string; description: string }> {
  return listPredefinedAgents();
}

// PascalCase alias for SDK compatibility
export const agentSpawnTool: Tool = {
  ...spawnAgentTool,
  name: 'AgentSpawn',
  description: `Advanced agent creation with full control over execution.

Use this tool when you need:
- Parallel execution (multiple agents at once)
- Background mode (fire and forget)
- Custom prompts or tools
- Budget control

For simple synchronous task delegation, use Task instead.

${spawnAgentTool.description}`,
};

// Execute multiple agents in parallel using the ParallelAgentCoordinator
async function executeParallelAgents(
  agents: Array<{ role: string; task: string; maxBudget?: number; dependsOn?: string[] }>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const isCancelledTaskError = (errorMessage?: string): boolean => {
    if (!errorMessage) return false;
    const normalized = errorMessage.toLowerCase();
    return normalized.includes('cancel') || normalized.includes('abort') || errorMessage.includes('取消');
  };

  const coordinator = getParallelAgentCoordinator();
  const emitter = getSwarmEventEmitter();
  const guard = getSpawnGuard();

  // SpawnGuard: check capacity for all requested agents
  const runningCount = guard.getRunningCount();
  const maxAgents = guard.getMaxAgents();
  const requestedCount = agents.length;
  if (runningCount + requestedCount > maxAgents) {
    return {
      success: false,
      error: `Cannot spawn ${requestedCount} agents: capacity exceeded (${runningCount} running, max ${maxAgents}). Use close_agent to free slots.`,
    };
  }

  // ========================================================================
  // Task DAG: 依赖环检测（在 spawn 之前验证）
  // ========================================================================
  const hasDependencies = agents.some(a => a.dependsOn && a.dependsOn.length > 0);
  if (hasDependencies) {
    // 构建 dependencies map: taskId -> Set<blockerIds>
    // 使用 role_index 作为 taskId（与下方 tasks 映射一致）
    const depMap = new Map<string, Set<string>>();
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const taskId = `agent_${agent.role}_${i}`;
      const blockers = new Set<string>();
      if (agent.dependsOn) {
        for (const dep of agent.dependsOn) {
          // 尝试将 role 名解析为 taskId（与下方 Phase 2 解析逻辑一致）
          const resolvedIdx = agents.findIndex(a => a.role === dep);
          const resolvedId = resolvedIdx >= 0 ? `agent_${dep}_${resolvedIdx}` : dep;
          blockers.add(resolvedId);
        }
      }
      depMap.set(taskId, blockers);
    }

    if (!validateNoCycles(depMap)) {
      const cycles = detectCycles(depMap);
      const cycleStr = cycles.map(c => c.join(' → ')).join('; ');
      return {
        success: false,
        error: `Cannot spawn parallel agents: dependency cycle detected. Cycles: ${cycleStr}`,
      };
    }
  }

  // Initialize coordinator with context
  coordinator.initialize({
    modelConfig: context.modelConfig as ModelConfig,
    toolResolver: context.resolver as ToolResolver,
    toolContext: context,
  });

  // Convert to AgentTask format
  // Phase 1: 生成稳定的 ID 并建立 role→id 映射（用于解析 dependsOn）
  const roleToId = new Map<string, string>();
  const cwd = context.workingDirectory || process.cwd();

  // Disabled tools lists
  const disabledTools = guard.getDisabledTools();
  const readonlyDisabledTools = guard.getReadonlyDisabledTools();
  const READONLY_ROLES = ['explorer', 'explore', 'reviewer'];

  const tasks: AgentTask[] = agents.map((agent, index) => {
    const agentConfig = getPredefinedAgent(agent.role);
    if (!agentConfig) {
      const availableIds = listPredefinedAgents().map(a => a.id);
      throw new Error(
        `Unknown agent: ${agent.role}. Available agents: ${availableIds.join(', ')}`
      );
    }

    // 使用 role_index 作为稳定 ID，避免 Date.now() 导致 dependsOn 无法匹配
    const taskId = `agent_${agent.role}_${index}`;
    roleToId.set(agent.role, taskId);
    // 也支持 "role-index" 格式引用
    roleToId.set(`${agent.role}-${index}`, taskId);

    // 根据 task 内容过滤文档工具 — 代码任务不需要 read_pdf/read_docx/read_xlsx
    const DOCUMENT_TOOLS = ['read_pdf', 'read_docx', 'read_xlsx'];
    const taskLower = agent.task.toLowerCase();
    const needsDocTools = DOCUMENT_TOOLS.some(t => taskLower.includes(t))
      || /\.(pdf|docx|xlsx|doc|xls)\b/.test(taskLower);
    let tools = getAgentTools(agentConfig);
    if (!needsDocTools) {
      tools = tools.filter(t => !DOCUMENT_TOOLS.includes(t));
    }

    // SpawnGuard: filter disabled tools (P2 + P3 readonly enforcement)
    const roleLower = agent.role.toLowerCase();
    const isReadonly = READONLY_ROLES.includes(roleLower);
    const toolsToDisable = isReadonly ? readonlyDisabledTools : disabledTools;
    tools = tools.filter(t => !toolsToDisable.includes(t));

    // 注入 subagent suffix
    let systemPrompt = getAgentPrompt(agentConfig);
    if (isCoreAgent(agent.role)) {
      const suffix = SUBAGENT_SUFFIXES[agent.role as CoreAgentId];
      if (suffix) {
        systemPrompt += suffix;
      }
    }

    return {
      id: taskId,
      role: agent.role,
      task: `[工作目录: ${cwd}] 所有文件路径基于此目录。\n\n${agent.task}`,
      systemPrompt,
      tools,
      maxIterations: getAgentMaxIterations(agentConfig),
      dependsOn: agent.dependsOn,
    };
  });

  // Phase 2: 解析 dependsOn — 将 role 名称映射到实际 task ID
  for (const task of tasks) {
    if (task.dependsOn) {
      task.dependsOn = task.dependsOn.map(dep => {
        // 优先精确匹配 task ID
        if (tasks.some(t => t.id === dep)) return dep;
        // 再尝试 role→id 映射
        return roleToId.get(dep) || dep;
      });
    }
  }

  // ========================================================================
  // Coordinator Mode: 3+ agent 时自动激活任务编排
  // ========================================================================
  let coordSession: ReturnType<typeof createCoordinatorSession> | undefined;
  if (shouldActivateCoordinator(tasks.length)) {
    coordSession = createCoordinatorSession();
    try {
      coordSession.decompose(
        tasks.map(t => t.task).join('\n'),
        tasks.map(t => ({
          id: t.id,
          description: t.task,
          dependsOn: t.dependsOn,
        }))
      );
    } catch {
      // decompose 失败（如循环依赖）不阻塞执行，上面已有独立的环检测
      coordSession = undefined;
    }
  }

  const launchGate = getSwarmLaunchApprovalGate();
  const launchApproval = await launchGate.requestApproval({
    sessionId: context.sessionId,
    summary: `准备并行启动 ${tasks.length} 个 agent`,
    tasks: tasks.map((task) => ({
      id: task.id,
      role: task.role,
      task: task.task.replace(/^\[工作目录:[^\]]+\]\s*所有文件路径基于此目录。\n\n/, ''),
      dependsOn: task.dependsOn,
      tools: [...task.tools],
      writeAccess: !READONLY_ROLES.includes(task.role.toLowerCase()),
    })),
  });

  if (!launchApproval.approved) {
    const reason = launchApproval.feedback?.trim();
    return {
      success: false,
      error: reason ? `Parallel launch rejected: ${reason}` : 'Parallel launch rejected by user',
    };
  }

  // ========================================================================
  // Fork Cache: 多 subagent 共享前缀，最大化 Prompt Cache 命中
  // ========================================================================
  if (shouldUseForkMode(tasks.length) && context.messages && context.messages.length > 0) {
    try {
      const childPrompts = tasks.map(t => t.task);
      const forkContexts = buildForkContexts({
        systemPrompt: tasks[0].systemPrompt || '',
        tools: [], // 工具定义由 executor 注入，此处仅用于缓存前缀
        messages: context.messages,
        childPrompts,
      });

      // 将 fork 后的 childDirective 回写到各 task
      for (let i = 0; i < tasks.length && i < forkContexts.length; i++) {
        tasks[i].task = forkContexts[i].childDirective;
      }

      // 对共享消息应用 cache_control 标记
      applyCacheControl(context.messages);
    } catch (err) {
      // Fork cache 失败不应阻止任务执行
      console.warn('[SpawnAgent] Fork cache setup failed, continuing without cache optimization:', err);
    }
  }

  // Emit swarm:started
  emitter.started(tasks.length, context.sessionId);
  for (const task of tasks) {
    emitter.agentAdded({ id: task.id, name: task.role, role: task.role });
  }

  // Bridge coordinator events to swarm events + coordinator session tracking
  const onTaskStart = (evt: { taskId: string; role: string }) => {
    emitter.agentUpdated(evt.taskId, { status: 'running', startTime: Date.now() });
    // Coordinator mode: 标记任务分配
    if (coordSession) {
      const coordTask = coordSession.getTask(evt.taskId);
      if (coordTask?.status === 'pending') {
        coordSession.assign(evt.taskId, evt.taskId);
      }
    }
  };
  const onTaskProgress = (evt: {
    taskId: string;
    role: string;
    snapshot: import('../../../shared/contract/swarm').SwarmAgentContextSnapshot;
  }) => {
    emitter.agentUpdated(evt.taskId, {
      status: 'running',
      contextSnapshot: evt.snapshot,
      toolCalls: evt.snapshot.tools.length,
    });
  };
  const onTaskComplete = (evt: { taskId: string; result: { success: boolean; duration: number; output?: string; error?: string } }) => {
    if (evt.result.success) {
      emitter.agentCompleted(evt.taskId, evt.result.output);
      coordSession?.complete(evt.taskId, evt.result.output ?? '');
    } else {
      const errorMessage = evt.result.error || 'Unknown error';
      if (isCancelledTaskError(errorMessage)) {
        emitter.agentUpdated(evt.taskId, {
          status: 'cancelled',
          endTime: Date.now(),
          error: 'Cancelled',
        });
      } else {
        emitter.agentFailed(evt.taskId, errorMessage);
      }
      coordSession?.fail(evt.taskId, errorMessage);
    }
  };
  const onTaskError = (evt: { taskId: string; error: string }) => {
    if (isCancelledTaskError(evt.error)) {
      emitter.agentUpdated(evt.taskId, {
        status: 'cancelled',
        endTime: Date.now(),
        error: 'Cancelled',
      });
    } else {
      emitter.agentFailed(evt.taskId, evt.error);
    }
    coordSession?.fail(evt.taskId, evt.error);
  };

  coordinator.on('task:start', onTaskStart);
  coordinator.on('task:progress', onTaskProgress);
  coordinator.on('task:complete', onTaskComplete);
  coordinator.on('task:error', onTaskError);

  const onRunAbort = () => coordinator.abortAllRunning('run_cancelled');
  if (context.abortSignal?.aborted) {
    onRunAbort();
  } else {
    context.abortSignal?.addEventListener('abort', onRunAbort, { once: true });
  }

  try {
    const result = await coordinator.executeParallel(tasks);

    // Aggregate results
    const aggregation = aggregateTeamResults(result.results, result.totalDuration);
    const resultByTaskId = new Map(result.results.map((taskResult) => [taskResult.taskId, taskResult]));
    const wasCancelled = Boolean(context.abortSignal?.aborted)
      || result.results.some((taskResult) => taskResult.cancelled || isCancelledTaskError(taskResult.error))
      || result.errors.some((error) => isCancelledTaskError(error.error));

    // Emit per-agent completion with aggregation data (cost, files, preview)
    for (const entry of aggregation.agentResults) {
      const taskResult = resultByTaskId.get(entry.agentId);
      emitter.agentUpdated(entry.agentId, {
        status: entry.status === 'completed'
          ? 'completed'
          : taskResult?.cancelled || isCancelledTaskError(taskResult?.error)
            ? 'cancelled'
            : 'failed',
      });
    }

    if (wasCancelled) {
      emitter.cancelled();
      return {
        success: false,
        error: `Parallel execution cancelled: ${result.errors.length} tasks did not complete.`,
        output: aggregation.agentResults.length > 0 ? aggregation.agentResults.map((entry) => {
          const taskResult = resultByTaskId.get(entry.agentId);
          const status = taskResult?.cancelled || isCancelledTaskError(taskResult?.error)
            ? 'cancelled'
            : entry.status;
          return `[${entry.role}] ${status}\n${entry.resultPreview || taskResult?.error || ''}`;
        }).join('\n\n---\n\n') : undefined,
      };
    }

    // Emit swarm:completed with aggregation
    emitter.completedWithAggregation({
      total: tasks.length,
      completed: result.results.filter(r => r.success).length,
      failed: result.results.filter(r => !r.success).length,
      parallelPeak: result.parallelism,
      totalTime: result.totalDuration,
    }, {
      summary: aggregation.summary,
      filesChanged: aggregation.filesChanged,
      totalCost: aggregation.totalCost,
      totalDuration: aggregation.totalDuration,
      speedup: aggregation.speedup,
      successRate: aggregation.successRate,
      totalIterations: aggregation.totalIterations,
    });

    // Format output for main agent (richer than before)
    const agentSummaries = aggregation.agentResults.map((entry) => {
      const filesNote = entry.filesChanged.length > 0
        ? `\nFiles: ${entry.filesChanged.join(', ')}`
        : '';
      const costNote = entry.stats.cost !== undefined
        ? ` · $${entry.stats.cost.toFixed(4)}`
        : '';
      return `[${entry.role}] ${entry.status} in ${entry.stats.durationMs}ms · ${entry.stats.iterations} iter · ${entry.stats.toolCalls} tools${costNote}\n${entry.resultPreview}${filesNote}`;
    }).join('\n\n---\n\n');

    const filesNote = aggregation.filesChanged.length > 0
      ? `\nFiles changed (${aggregation.filesChanged.length}):\n${aggregation.filesChanged.map(f => `  ${f}`).join('\n')}`
      : '';

    const coordNote = coordSession
      ? `\n- Coordinator mode: active (${coordSession.getStats().completed}/${coordSession.getStats().total} tasks orchestrated)`
      : '';

    if (result.success) {
      return {
        success: true,
        output: `${aggregation.summary}

Stats:
- Total duration: ${result.totalDuration}ms (${aggregation.speedup.toFixed(1)}x parallel speedup)
- Max parallelism: ${result.parallelism}
- Success rate: ${(aggregation.successRate * 100).toFixed(0)}% (${result.results.filter(r => r.success).length}/${result.results.length})
- Total cost: $${aggregation.totalCost.toFixed(4)}
- Total iterations: ${aggregation.totalIterations} · Total tool calls: ${aggregation.totalToolCalls}${coordNote}
${filesNote}

Agent Results:
${agentSummaries}${coordSession ? '\n\n---\n\n' + coordSession.synthesize() : ''}`,
      };
    } else {
      return {
        success: false,
        error: `Parallel execution failed: ${result.errors.length} errors. ${aggregation.summary}`,
        output: agentSummaries + (coordSession ? '\n\n' + coordSession.synthesize() : ''),
      };
    }
  } catch (error) {
    emitter.cancelled();
    return {
      success: false,
      error: `Parallel execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  } finally {
    // Cleanup event listeners
    coordinator.off('task:start', onTaskStart);
    coordinator.off('task:progress', onTaskProgress);
    coordinator.off('task:complete', onTaskComplete);
    coordinator.off('task:error', onTaskError);
    context.abortSignal?.removeEventListener('abort', onRunAbort);
  }
}
