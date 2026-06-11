// ============================================================================
// Spawn Agent — execute helpers
// Gen 7: Multi-Agent capability
//
// P1 Wave 3 multiagent native: 原 spawnAgentTool / agentSpawnTool (legacy Tool)
// 已删除，protocol 入口在 src/main/tools/modules/multiagent/spawnAgent.ts。
// 本文件仅保留：
//   - executeSpawnAgent(params, ctx)  — single + parallel mode 入口
//   - getSpawnedAgent / listSpawnedAgents / getAvailableAgents — service helpers
//   - SpawnedAgent type — backward-compat alias
//   - DEFAULT_ISOLATION map
// ============================================================================

import type { ToolContext, ToolExecutionResult } from '../../tools/types';
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
import { SWARM_STATUS_REPORT_SUFFIX, parseStatusReport } from './statusReport';
import {
  SubagentContextBuilder,
  getAgentContextLevel,
} from '../subagentContextBuilder';
import { getSwarmEventEmitter } from '../swarmEventPublisher';
import { checkReadonlyParentRule, buildParentContextFromToolContext, type ParentContext } from '../childContext';
import { getPermissionModeManager } from '../../permissions/modes';
import { getSpawnGuard } from '../spawnGuard';
import { routeFailureCode } from '../../../shared/contract/cancellation';
import { isParentRunAlive } from '../orphanLiveness';
import { getSwarmLaunchApprovalGate } from '../swarmLaunchApproval';
import { createAgentWorktree, cleanupAgentWorktree, cleanupOrphanedWorktrees } from '../agentWorktree';
import { aggregateTeamResults } from '../resultAggregator';
import { shouldUseForkMode, buildForkContexts, applyCacheControl } from '../forkContext.js';
import { validateNoCycles, detectCycles } from '../taskDag.js';
import {
  buildAgentTeamFailureRecoveryProposal,
  recordLongTaskRecoveryProposal,
} from '../../handoff/longTaskRecoveryProposal';
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

/**
 * spawn_agent / AgentSpawn 的执行入口（接 legacy ToolContext）
 *
 * Schema 在 src/main/tools/modules/multiagent/spawnAgent.schema.ts，
 * protocol 入口在 src/main/tools/modules/multiagent/spawnAgent.ts。
 * 本函数签名保留 legacy ToolContext 以避免大规模 refactor 932 行业务逻辑；
 * native module 用 buildLegacyCtxFromProtocol 桥接 protocol → legacy ctx。
 */
export async function executeSpawnAgent(
  params: Record<string, unknown>,
  context: ToolContext,
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

    const guard = getSpawnGuard();

    // ========================================================================
    // spawn 嵌套深度截断（执行层防线）
    // ========================================================================
    const parentDepth = context.spawnDepth ?? 0;
    const childDepth = parentDepth + 1;
    const maxDepth = guard.getMaxDepth(context.spawnMaxDepth);
    if (!guard.checkDepth(childDepth, context.spawnMaxDepth)) {
      return {
        success: false,
        error: `DEPTH_LIMIT: spawn 嵌套深度超限（current depth ${childDepth} exceeds maxDepth ${maxDepth}）。请改用本层已有上下文继续汇总，或让父 agent 重新拆分任务。`,
        metadata: {
          cancellationReason: 'depth-limit',
          failureRouting: routeFailureCode('depth-limit'),
          childDepth,
          maxDepth,
        },
      };
    }
    const treeId = context.spawnTreeId || context.sessionId || 'default';

    // Handle parallel execution mode
    if (parallel && agents && agents.length > 0) {
      return executeParallelAgents(agents, {
        ...context,
        spawnDepth: childDepth,
        spawnMaxDepth: context.spawnMaxDepth,
        spawnTreeId: treeId,
        spawnQueueTimeoutMs: context.spawnQueueTimeoutMs,
        spawnParentStartedAt: context.spawnParentStartedAt,
        spawnParentTimeoutMs: context.spawnParentTimeoutMs,
        parentRemainingBudget: context.parentRemainingBudget,
      });
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
      tools = customTools || ['Read', 'Glob', 'Grep']; // Default read-only tools for safety
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

    // 根据 task 内容过滤文档工具 — 代码任务不需要文档/Excel 专用读取工具
    {
      const DOCUMENT_TOOLS = ['read_pdf', 'read_docx', 'read_xlsx', 'ReadDocument', 'ExcelAutomate'];
      const taskLower = task.toLowerCase();
      const needsDocTools = DOCUMENT_TOOLS.some(t => taskLower.includes(t.toLowerCase()))
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
    // ========================================================================
    // P3: 场景 D 兜底 — readonly 父 role 禁止 spawn writer 子 agent
    // 这是 hard topology rule，不受 inheritance 配置影响（即便用户选 independent
    // 也生效）。基于 plan §4.7 / AC-4。
    // ========================================================================
    const readonlyCheck = checkReadonlyParentRule(
      context.agentRole,
      role,
      [], // FullAgentConfig 不带 capabilities；spawnAgent 这层只用 role 做黑名单匹配
    );
    if (!readonlyCheck.allowed) {
      // swarm 护栏 P1-2 #2：readonly 父拒启 writer 子 → 结构化 child-refusal 失败码，
      // 让编排层按 routeFailureCode（'surface'）上抛而非 parse error 字符串。
      return {
        success: false,
        error: `PERMISSION_DENIED: ${readonlyCheck.reason}. Switch to default mode or spawn a non-writer agent.`,
        metadata: {
          cancellationReason: 'child-refusal',
          failureRouting: routeFailureCode('child-refusal'),
        },
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

    let slotLease: { release: () => void } | undefined;
    let registeredWithGuard = false;

    try {
      slotLease = await guard.acquireSlot({
        treeId,
        timeoutMs: context.spawnQueueTimeoutMs,
      });
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
          slotLease?.release();
          slotLease = undefined;
          return {
            success: false,
            error: `Failed to create worktree for agent: ${errMsg}. Ensure you are in a git repository.`,
          };
        }
      }

      const enrichedTask = `[工作目录: ${cwd}] 所有文件路径基于此目录。\n\n${task}`;

      // Create AbortController for this agent
      const abortController = new AbortController();

      // Bridge parent abortSignal to this child controller.
      // 没有这个 bridge 的话单 spawn 路径下，主 agent ESC 后 child 还会跑完当前 LLM call。
      // Cascade 透传 reason（'user-cancel' / 'session-switch' / 'parent-cancel'）
      // 供 subagentExecutor 的 abort 检测块区分。
      if (context.abortSignal) {
        if (context.abortSignal.aborted) {
          abortController.abort(context.abortSignal.reason ?? 'parent-cancel');
        } else {
          const parentSignal = context.abortSignal;
          parentSignal.addEventListener(
            'abort',
            () => {
              if (!abortController.signal.aborted) {
                abortController.abort(parentSignal.reason ?? 'parent-cancel');
              }
            },
            { once: true },
          );
        }
      }

      // Build executor context.
      // 注入 agentId 到 toolContext —— 让子 agent 走 BrowserPool / ComputerSurface 的 per-agent 实例。
      // 共享 context 不能直接 mutate（父 agent 也用同一个），clone 后注入。
      // P3: 注入 parentContext，让 subagentExecutor 走 buildChildContext 三档合并
      // 现阶段从 ToolContext 推导；后续 caller 在 P4 阶段补全父级 rules/memory/tools。
      const parentContext: ParentContext = buildParentContextFromToolContext(context, {
        permissionMode: getPermissionModeManager().getMode() as string,
        availableTools: tools.slice(),
        role: context.agentRole,
      });

      // 孤儿回收（swarm 护栏 P1-2 #5）：仅后台 detached 子代理注入父探活。
      // 前台子代理被父 await，不会成孤儿，跳过（多余开销）。
      // 动态 import 取 TaskManager，避开 task→agent 的静态循环依赖。
      let isParentAlive: (() => boolean) | undefined;
      if (!waitForCompletion && context.sessionId) {
        try {
          const { getTaskManager } = await import('../../task/TaskManager');
          const tm = getTaskManager();
          const parentSessionId = context.sessionId;
          const parentState = tm.getSessionState(parentSessionId);
          // 只在父确实处于活跃 run 时装探活；否则无法判定父子归属，保守不杀
          if (parentState.status === 'running' || parentState.status === 'paused') {
            const parentStartTime = parentState.startTime;
            isParentAlive = () =>
              isParentRunAlive(tm.getSessionState(parentSessionId), parentStartTime);
          }
        } catch {
          // TaskManager 不可用（测试 / CLI / 无 run 上下文）→ 不装探活
        }
      }

      const executorContext = {
        modelConfig: context.modelConfig as ModelConfig,
        toolResolver: context.resolver as ToolResolver,
        // swarm 护栏 P1-2 #2：把递增后的深度注入子 toolContext，让深度沿 spawn 链路流转
        toolContext: {
          ...context,
          agentId,
          spawnDepth: childDepth,
          spawnMaxDepth: context.spawnMaxDepth,
          spawnTreeId: treeId,
          spawnQueueTimeoutMs: context.spawnQueueTimeoutMs,
          spawnParentStartedAt: context.spawnParentStartedAt,
          spawnParentTimeoutMs: context.spawnParentTimeoutMs,
          parentRemainingBudget: context.parentRemainingBudget,
        },
        parentToolUseId: context.currentToolCallId,
        abortSignal: abortController.signal,
        spawnGuardId: agentId,
        executionAgentId: agentId,
        worktreePath: worktreeInfo?.worktreePath,
        hookManager: context.hookManager,
        parentContext,
        parentRemainingBudget: context.parentRemainingBudget,
        // 后台 detached 子代理的父探活（仅 !waitForCompletion 时非 undefined）
        isParentAlive,
      };

      const executorConfig = {
        name: agentName,
        // 持久化角色资产绑定 key（roles/<roleId>/）。declarative 模式下 role 即 agent 注册 id；
        // dynamic 模式没有 role，不参与角色资产链路。
        roleId: role || undefined,
        systemPrompt,
        availableTools: tools,
        // GAP-011：声明式 agent 定义里的预装 skills 透传给 executor（方向 A）
        skills: agentConfig?.skills,
        maxIterations,
        permissionPreset,
        maxBudget: effectiveMaxBudget,
      };

      if (waitForCompletion) {
        // Execute and wait for result
        const promise = executor.execute(enrichedTask, executorConfig, executorContext);

        // Register with SpawnGuard
        guard.register(agentId, role || 'dynamic', task, promise, abortController, {
          treeId,
          slotAcquired: true,
        });
        registeredWithGuard = true;
        slotLease = undefined;

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
            metadata: {
              agentId,
              cost: result.cost,
              tokensUsed: result.tokensUsed,
            },
          };
        } else {
          return {
            success: false,
            error: `Agent [${agentName}] failed: ${result.error}${worktreeNote}`,
            output: result.output,
            metadata: {
              agentId,
              cost: result.cost,
              tokensUsed: result.tokensUsed,
              cancellationReason: result.cancellationReason,
            },
          };
        }
      } else {
        // Start agent in background
        const promise = executor.execute(enrichedTask, executorConfig, executorContext);

        // Register with SpawnGuard (auto-tracks completion)
        guard.register(agentId, role || 'dynamic', task, promise, abortController, {
          treeId,
          slotAcquired: true,
        });
        registeredWithGuard = true;
        slotLease = undefined;

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
      if (!registeredWithGuard) {
        slotLease?.release();
      }
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Failed to spawn agent: ${errorMsg}`,
      };
    }
}

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

// AgentSpawn (PascalCase variant) shares execute body with spawn_agent — the
// schema-level distinction is now in spawnAgent.schema.ts. Both protocol entries
// dispatch to executeSpawnAgent above.

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

    // 根据 task 内容过滤文档工具 — 代码任务不需要文档/Excel 专用读取工具
    const DOCUMENT_TOOLS = ['read_pdf', 'read_docx', 'read_xlsx', 'ReadDocument', 'ExcelAutomate'];
    const taskLower = agent.task.toLowerCase();
    const needsDocTools = DOCUMENT_TOOLS.some(t => taskLower.includes(t.toLowerCase()))
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
    // 协作可见性（P1-3）：所有并行子代理统一自报 STATUS/DECISION，喂给讨论流
    systemPrompt += SWARM_STATUS_REPORT_SUFFIX;

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
      // 协作可见性（P1-3）：解析子代理自报的人话状态 / 决策 → 讨论流
      const report = parseStatusReport(evt.result.output ?? '');
      const reportRole = tasks.find((t) => t.id === evt.taskId)?.role;
      const reportAt = Date.now();
      if (report.status) {
        emitter.contextUpdate({ kind: 'status', agentId: evt.taskId, role: reportRole, content: report.status, at: reportAt });
      }
      if (report.decision) {
        emitter.contextUpdate({ kind: 'decision', agentId: evt.taskId, role: reportRole, content: report.decision, at: reportAt });
      }
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

  // 协作可见性（P1-3）：SharedContext 发现（discovery）桥接成讨论流事件
  const onDiscovery = (evt: { taskId?: string; role?: string; finding?: string; key?: string; value?: unknown; at?: number }) => {
    const content = evt.finding ?? (typeof evt.value === 'string' ? evt.value : evt.key);
    if (!content) return;
    emitter.contextUpdate({
      kind: 'finding',
      agentId: evt.taskId,
      role: evt.role ?? (evt.taskId ? tasks.find((t) => t.id === evt.taskId)?.role : undefined),
      content,
      key: evt.key,
      at: evt.at ?? Date.now(),
    });
  };

  coordinator.on('task:start', onTaskStart);
  coordinator.on('task:progress', onTaskProgress);
  coordinator.on('task:complete', onTaskComplete);
  coordinator.on('task:error', onTaskError);
  coordinator.on('discovery', onDiscovery);

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
    const totalTokensUsed = result.results.reduce((sum, taskResult) => sum + (taskResult.tokensUsed ?? 0), 0);
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
        metadata: {
          cost: aggregation.totalCost,
          tokensUsed: totalTokensUsed,
        },
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
        metadata: {
          cost: aggregation.totalCost,
          tokensUsed: totalTokensUsed,
        },
      };
    } else {
      const failedTaskIds = new Set(result.errors.map((entry) => entry.taskId));
      const failedTasks = result.results
        .filter((taskResult) => !taskResult.success || failedTaskIds.has(taskResult.taskId))
        .map((taskResult) => {
          const task = tasks.find((candidate) => candidate.id === taskResult.taskId);
          return {
            taskId: taskResult.taskId,
            role: taskResult.role,
            task: task?.task,
            error: taskResult.error,
          };
        });
      if (failedTasks.length === 0) {
        failedTasks.push(...result.errors.map((entry) => {
          const task = tasks.find((candidate) => candidate.id === entry.taskId);
          return {
            taskId: entry.taskId,
            role: task?.role ?? entry.taskId,
            task: task?.task,
            error: entry.error,
          };
        }));
      }
      recordLongTaskRecoveryProposal(buildAgentTeamFailureRecoveryProposal({
        sessionId: context.sessionId,
        sourceMessageId: context.currentToolCallId ? `agent-team:${context.currentToolCallId}:failure` : undefined,
        totalTasks: tasks.length,
        failedTasks,
        summary: aggregation.summary,
      }));
      return {
        success: false,
        error: `Parallel execution failed: ${result.errors.length} errors. ${aggregation.summary}`,
        output: agentSummaries + (coordSession ? '\n\n' + coordSession.synthesize() : ''),
        metadata: {
          cost: aggregation.totalCost,
          tokensUsed: totalTokensUsed,
        },
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
    coordinator.off('discovery', onDiscovery);
    context.abortSignal?.removeEventListener('abort', onRunAbort);
  }
}
