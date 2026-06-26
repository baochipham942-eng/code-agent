// ============================================================================
// Workflow Orchestrate — execute helpers
// Gen 7: Multi-Agent capability
//
// P1 Wave 3 multiagent native: 原 workflowOrchestrateTool / WorkflowOrchestrateTool
// (legacy Tool) 已删除，protocol 入口在 src/main/tools/modules/multiagent/
// workflowOrchestrate.ts。本文件仅保留：
//   - executeWorkflowOrchestrate(params, ctx)
//   - getAvailableWorkflows  — service helper
//   - 内部 helpers（executeStage / extractStructuredData / etc）
// ============================================================================

import type { ToolContext, ToolExecutionResult } from '../../tools/types';
import type { ModelConfig } from '../../../shared/contract';
import type {
  WorkflowStage,
  WorkflowTemplate,
  StageContext,
  StageResult,
  ResolvedWorkflowStageToolPolicyMode,
  WorkflowStageToolPolicy,
  WorkflowStageToolPolicySnapshot,
} from '../../../shared/contract/workflow';
import {
  BUILT_IN_WORKFLOWS,
  getBuiltInWorkflow,
  listBuiltInWorkflows,
} from '../../../shared/contract/workflow';
import { getSubagentExecutor } from '../subagentExecutor';
import type { ToolResolver } from '../../tools/dispatch/toolResolver';
import { resolveToolAlias } from '../../services/toolSearch/deferredTools';
import {
  getPredefinedAgent,
  getAgentPrompt,
  getAgentTools,
  type FullAgentConfig,
} from '../agentDefinition';
import { applyEffortControls } from '../runtime/contextAssembly/effortControls';
import { WORKFLOW_ANTI_LOOP } from '../../../shared/constants';
import { validateAgainstSchema, type JsonSchema } from '../structuredOutput';
import { createLogger } from '../../services/infra/logger';
import {
  AgentFailureCode,
  inferAgentFailureCode,
} from '../../../shared/contract/agentFailure';

const logger = createLogger('WorkflowOrchestrate');
export const DEFAULT_WORKFLOW_STAGE_TIMEOUT_MS = 240_000;
const MAX_WORKFLOW_STAGE_TIMEOUT_MS = 900_000;

const CLAUDE_STAGE_MODEL_BY_TIER: Record<Exclude<FullAgentConfig['model'], 'inherit' | undefined>, string> = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-4-6',
  powerful: 'claude-opus-4-7',
};

const TOOL_POLICY_MODES = new Set([
  'inherit',
  'none',
  'noTool',
  'readonly',
  'readOnly',
  'allowlist',
]);

const LEGACY_WORKFLOW_ROLE_ALIASES: Record<string, string> = {
  architect: 'plan',
  planner: 'plan',
  documenter: 'coder',
  writer: 'coder',
  tester: 'reviewer',
  debugger: 'explore',
  explorer: 'explore',
  researcher: 'explore',
  'code-explore': 'explore',
  'visual-understanding': 'explore',
  'visual-processing': 'coder',
};

function normalizeWorkflowRole(roleOrId: string): { role: string; originalRole?: string } {
  const trimmed = roleOrId.trim();
  const normalized = LEGACY_WORKFLOW_ROLE_ALIASES[trimmed] ?? LEGACY_WORKFLOW_ROLE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  return normalized === roleOrId ? { role: normalized } : { role: normalized, originalRole: roleOrId };
}

function normalizeToolPolicyMode(
  policy: WorkflowStageToolPolicy | undefined,
): ResolvedWorkflowStageToolPolicyMode {
  if (!policy?.mode && Array.isArray(policy?.tools)) {
    return policy.tools.length === 0 ? 'none' : 'allowlist';
  }

  switch (policy?.mode) {
    case 'noTool':
    case 'none':
      return 'none';
    case 'readOnly':
    case 'readonly':
      return 'readonly';
    case 'allowlist':
      return 'allowlist';
    case 'inherit':
    case undefined:
      return 'inherit';
    default:
      return 'inherit';
  }
}

function validateStageToolPolicy(
  stage: WorkflowStage,
): { policy?: WorkflowStageToolPolicy; error?: string } {
  const policy = stage.toolPolicy;
  if (!policy) {
    return {};
  }

  if (typeof policy !== 'object' || Array.isArray(policy)) {
    return { error: `Invalid toolPolicy for stage "${stage.name}": expected object` };
  }

  if (policy.mode !== undefined && !TOOL_POLICY_MODES.has(policy.mode)) {
    return { error: `Invalid toolPolicy.mode for stage "${stage.name}": ${String(policy.mode)}` };
  }

  if (policy.tools !== undefined) {
    if (!Array.isArray(policy.tools) || policy.tools.some((tool) => typeof tool !== 'string' || tool.trim().length === 0)) {
      return { error: `Invalid toolPolicy.tools for stage "${stage.name}": expected string array` };
    }
  }

  if (policy.maxToolCalls !== undefined) {
    if (!Number.isInteger(policy.maxToolCalls) || policy.maxToolCalls < 0) {
      return { error: `Invalid toolPolicy.maxToolCalls for stage "${stage.name}": expected non-negative integer` };
    }
  }

  return { policy };
}

function resolveStageExecutionTimeout(
  stage: WorkflowStage,
): { maxExecutionTimeMs: number; error?: string } {
  const rawTimeout = (stage as WorkflowStage & { maxExecutionTimeMs?: unknown }).maxExecutionTimeMs;
  if (rawTimeout === undefined) {
    return { maxExecutionTimeMs: DEFAULT_WORKFLOW_STAGE_TIMEOUT_MS };
  }

  if (!Number.isInteger(rawTimeout) || rawTimeout <= 0) {
    return {
      maxExecutionTimeMs: DEFAULT_WORKFLOW_STAGE_TIMEOUT_MS,
      error: `Invalid maxExecutionTimeMs for stage "${stage.name}": expected positive integer milliseconds`,
    };
  }

  return {
    maxExecutionTimeMs: Math.min(rawTimeout, MAX_WORKFLOW_STAGE_TIMEOUT_MS),
  };
}

function resolveStageToolPolicy(
  stage: WorkflowStage,
  declaredTools: string[],
  resolver?: ToolResolver,
): { policy?: WorkflowStageToolPolicySnapshot; error?: string } {
  const validation = validateStageToolPolicy(stage);
  if (validation.error) {
    return { error: validation.error };
  }

  const rawPolicy = validation.policy;
  const mode = normalizeToolPolicyMode(rawPolicy);
  const declaredToolSet = new Set(declaredTools);
  const declaredCanonicalToolSet = new Set(declaredTools.map((tool) => resolveToolAlias(tool)));
  const requestedTools = rawPolicy?.tools?.map((tool) => tool.trim());
  const requestedCanonicalTools = requestedTools?.map((tool) => resolveToolAlias(tool));
  let availableTools: string[] = declaredTools;
  let maxToolCalls = rawPolicy?.maxToolCalls;

  if (mode === 'none') {
    availableTools = [];
    maxToolCalls = 0;
  } else if (mode === 'readonly') {
    availableTools = declaredTools.filter((toolName) => {
      const canonicalToolName = resolveToolAlias(toolName);
      const definition = resolver?.getDefinition(canonicalToolName) ?? resolver?.getDefinition(toolName);
      return definition?.permissionLevel === 'read';
    });
  } else if (mode === 'allowlist') {
    const allowed = new Set(requestedCanonicalTools ?? requestedTools ?? []);
    availableTools = declaredTools.filter((toolName) => allowed.has(resolveToolAlias(toolName)));
    if ((requestedTools?.length ?? 0) === 0) {
      maxToolCalls = 0;
    }
  }

  const availableSet = new Set(availableTools);
  const blockedTools = declaredTools.filter((toolName) => !availableSet.has(toolName));
  const ignoredRequestedTools = requestedTools?.filter((toolName, index) => {
    const canonicalToolName = requestedCanonicalTools?.[index] ?? toolName;
    return !declaredToolSet.has(toolName) && !declaredCanonicalToolSet.has(canonicalToolName);
  }) ?? [];
  if (ignoredRequestedTools.length > 0) {
    logger.warn('[Stage] toolPolicy requested tools outside declared role tools', {
      stage: stage.name,
      mode,
      ignoredRequestedTools,
    });
  }

  return {
    policy: {
      mode,
      ...(requestedTools ? { requestedTools } : {}),
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
      availableTools,
      blockedTools: [...new Set([...blockedTools, ...ignoredRequestedTools])],
    },
  };
}

function resolveStageModelConfig(
  baseConfig: ModelConfig,
  tier: FullAgentConfig['model'] | undefined,
  stageName: string,
): ModelConfig {
  const withWorkflowThinking = (config: ModelConfig): ModelConfig =>
    applyEffortControls(config, 'high');

  if (!tier || tier === 'inherit') {
    return withWorkflowThinking(baseConfig);
  }

  const claudeModel = CLAUDE_STAGE_MODEL_BY_TIER[tier];
  if (!claudeModel) {
    return withWorkflowThinking(baseConfig);
  }

  if (baseConfig.provider === 'claude') {
    logger.info('Using Claude model tier for stage', {
      stage: stageName,
      tier,
      model: claudeModel,
    });
    return withWorkflowThinking({
      ...baseConfig,
      model: claudeModel,
    });
  }

  logger.info('Using inherited model for provider-incompatible stage tier', {
    stage: stageName,
    tier,
    provider: baseConfig.provider,
    model: baseConfig.model,
  });
  return withWorkflowThinking(baseConfig);
}

/**
 * 尝试从输出中提取 JSON 数据
 */
function extractStructuredData(output: string): Record<string, unknown> | undefined {
  const parseRecord = (candidate: string): Record<string, unknown> | undefined => {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  };

  // 1. 尝试提取 ```json ... ``` 代码块
  const jsonCodeBlockMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonCodeBlockMatch) {
    try {
      return parseRecord(jsonCodeBlockMatch[1]);
    } catch (error) {
      logger.debug('Failed to parse JSON code block', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 2. 尝试提取 ``` ... ``` 代码块中的 JSON
  const codeBlockMatch = output.match(/```\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    try {
      return parseRecord(codeBlockMatch[1]);
    } catch {
      // Not valid JSON, continue
    }
  }

  // 3. 尝试直接解析整个输出为 JSON
  try {
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return parseRecord(trimmed);
    }
  } catch {
    // Not valid JSON
  }

  // 4. 尝试提取内联 JSON 对象
  const inlineJsonMatch = output.match(/\{[\s\S]*"(?:type|regions|elements|textRegions)"[\s\S]*\}/);
  if (inlineJsonMatch) {
    try {
      return parseRecord(inlineJsonMatch[0]);
    } catch {
      // Not valid JSON
    }
  }

  return undefined;
}

/**
 * 从输出中提取生成的文件路径
 */
function extractGeneratedFiles(output: string): Array<{ path: string; type: 'image' | 'text' | 'data' }> {
  const files: Array<{ path: string; type: 'image' | 'text' | 'data' }> = [];

  // 匹配常见的文件路径模式
  const patterns = [
    // 📄 标注图片: /path/to/file.png
    /📄\s*标注图片:\s*([^\n]+)/g,
    // 文件已保存到: /path/to/file
    /文件已保存到:\s*([^\n]+)/g,
    // 输出路径: /path/to/file
    /输出路径:\s*([^\n]+)/g,
    // 已生成: /path/to/file
    /已生成:\s*([^\n]+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(output)) !== null) {
      const filePath = match[1].trim();
      // 判断文件类型
      const ext = filePath.toLowerCase().split('.').pop() || '';
      let fileType: 'image' | 'text' | 'data' = 'data';
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
        fileType = 'image';
      } else if (['txt', 'md', 'json', 'yaml', 'yml'].includes(ext)) {
        fileType = 'text';
      }
      files.push({ path: filePath, type: fileType });
    }
  }

  return files;
}

/**
 * workflow_orchestrate 的执行入口（接 legacy ToolContext）
 *
 * Schema 在 src/main/tools/modules/multiagent/workflowOrchestrate.schema.ts；
 * protocol 入口在同目录的 .ts native module。
 */
export async function executeWorkflowOrchestrate(
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
    const workflowName = params.workflow as string;
    const task = params.task as string;
    const customStages = params.stages as WorkflowStage[] | undefined;
    const parallel = params.parallel !== false;

    // Check for required context
    if (!context.modelConfig) {
      return {
        success: false,
        error: 'workflow_orchestrate requires modelConfig in context',
        metadata: {
          failureCode: AgentFailureCode.ModelError,
        },
      };
    }

    // Get workflow definition
    let workflow: WorkflowTemplate;
    if (workflowName === 'custom') {
      if (!customStages || customStages.length === 0) {
        return {
          success: false,
          error: 'Custom workflow requires stages array',
          metadata: {
            failureCode: AgentFailureCode.ToolUnavailable,
          },
        };
      }
      workflow = {
        name: 'Custom Workflow',
        description: 'User-defined workflow',
        stages: customStages,
      };
    } else {
      // Use type-safe built-in workflow lookup
      const builtInWorkflow = getBuiltInWorkflow(workflowName);
      if (!builtInWorkflow) {
        const availableWorkflows = listBuiltInWorkflows().map(w => w.id).join(', ');
        return {
          success: false,
          error: `Unknown workflow: ${workflowName}. Available: ${availableWorkflows}`,
          metadata: {
            failureCode: AgentFailureCode.ToolUnavailable,
          },
        };
      }
      workflow = builtInWorkflow;
    }

    // Legacy roles support - empty since all agents are now unified in PREDEFINED_AGENTS
    const legacyRoles: Record<string, { name: string; systemPrompt: string; tools: string[] }> = {};
    const results: StageResult[] = [];
    // 使用结构化上下文替代纯文本输出
    const stageContexts: Map<string, StageContext> = new Map();

    logger.info('[Workflow] 开始执行工作流', {
      name: workflow.name,
      stageCount: workflow.stages.length,
      stages: workflow.stages.map(s => `${s.name}(${s.role})`).join(' -> '),
    });

    try {
      // Build execution groups (stages with same dependencies can run in parallel)
      const executionGroups = buildExecutionGroups(workflow.stages);
      logger.info('[Workflow] 执行组构建完成', {
        groupCount: executionGroups.length,
        groups: executionGroups.map((g, i) => `Group${i+1}: [${g.map(s => s.name).join(', ')}]`).join(', '),
      });

      // GAP-004: 反死循环状态（重试/回退路由/circuit breaker）
      const antiLoop: WorkflowAntiLoopState = { totalFallbacks: 0, breakerTripped: false };

      for (const group of executionGroups) {
        logger.info('[Workflow] 执行阶段组', { stages: group.map(s => s.name).join(', ') });

        if (parallel && group.length > 1) {
          // Execute stages in parallel
          const groupResults = await Promise.all(
            group.map((stage) =>
              executeStageWithAntiLoop(stage, task, stageContexts, legacyRoles, context, workflow.stages, antiLoop)
            )
          );

          for (let i = 0; i < group.length; i++) {
            results.push(groupResults[i]);
            if (groupResults[i].success && groupResults[i].context) {
              const contextValue = groupResults[i].context;
              if (contextValue) {
                stageContexts.set(group[i].name, contextValue);
              }
            }
          }
        } else {
          // Execute stages sequentially
          for (const stage of group) {
            const result = await executeStageWithAntiLoop(
              stage, task, stageContexts, legacyRoles, context, workflow.stages, antiLoop,
            );
            results.push(result);
            if (result.success && result.context) {
              stageContexts.set(stage.name, result.context);
            }
            // breaker 跳闸 → 不再执行本组后续阶段
            if (antiLoop.breakerTripped) break;
          }
        }

        // GAP-004: circuit breaker 跳闸 → 终止 workflow，剩余阶段不执行
        if (antiLoop.breakerTripped) {
          logger.error('[Workflow] circuit breaker 跳闸，终止 workflow', {
            reason: antiLoop.breakerReason,
            executedStages: results.length,
            totalStages: workflow.stages.length,
          });
          const executedNames = new Set(results.map((r) => r.stage));
          const skippedStages = workflow.stages.filter((s) => !executedNames.has(s.name));
          return {
            success: false,
            error: `Workflow halted by circuit breaker: ${antiLoop.breakerReason}`,
            output: [
              `## Workflow: ${workflow.name} (已被 circuit breaker 终止)`,
              '',
              `**原因:** ${antiLoop.breakerReason}`,
              '',
              `**已执行阶段:** ${results.map((r) => `${r.success ? '✅' : '❌'} ${r.stage}`).join(', ')}`,
              `**未执行阶段:** ${skippedStages.map((s) => s.name).join(', ') || '(无)'}`,
              '',
              '请检查失败阶段的错误后人工介入（调整 prompt / 修复依赖 / 重新发起）。',
            ].join('\n'),
            metadata: {
              workflow: workflowName,
              workflowName: workflow.name,
              circuitBreakerTripped: true,
              failureCode: AgentFailureCode.WorkflowStageFailed,
              stageCount: workflow.stages.length,
              completedStages: results.filter(r => r.success).length,
              failedStages: results.filter(r => !r.success).length,
              skippedStages: skippedStages.map((s) => s.name),
              totalFallbacks: antiLoop.totalFallbacks,
              stages: results.map((result) => ({
                name: result.stage,
                role: result.role,
                success: result.success,
                duration: result.duration,
                toolsUsed: result.context?.toolsUsed ?? [],
                toolPolicy: result.context?.toolPolicy,
                error: result.error,
                failureCode: result.failureCode,
              })),
            },
          };
        }
      }

      // Build summary
      const successCount = results.filter(r => r.success).length;
      const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
      const failedStages = results.filter(r => !r.success);
      const workflowError = failedStages
        .map(r => `${r.stage} (${r.role}): ${r.error || 'Stage failed'}`)
        .join('; ');

      const stagesSummary = results.map((r) => {
        const icon = r.success ? '✅' : '❌';
        return `${icon} **${r.stage}** (${r.role}) - ${(r.duration / 1000).toFixed(1)}s
${r.success ? r.output.substring(0, 200) + (r.output.length > 200 ? '...' : '') : `Error: ${r.error}`}`;
      }).join('\n\n');

      return {
        success: successCount === results.length,
        output: `## Workflow: ${workflow.name}

**Task:** ${task}

**Summary:** ${successCount}/${results.length} stages completed
**Total Duration:** ${(totalDuration / 1000).toFixed(1)}s

---

### Stage Results:

${stagesSummary}`,
        ...(workflowError ? { error: workflowError } : {}),
        metadata: {
          workflow: workflowName,
          workflowName: workflow.name,
          stageCount: results.length,
          completedStages: successCount,
          failedStages: failedStages.length,
          ...(workflowError ? { failureCode: AgentFailureCode.WorkflowStageFailed } : {}),
          totalDuration,
          stages: results.map((result) => ({
            name: result.stage,
            role: result.role,
            success: result.success,
            duration: result.duration,
            toolsUsed: result.context?.toolsUsed ?? [],
            toolPolicy: result.context?.toolPolicy,
            error: result.error,
            failureCode: result.failureCode,
          })),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Workflow failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        metadata: {
          workflow: workflowName,
          workflowName: workflow.name,
          failureCode: inferAgentFailureCode({
            error,
            defaultCode: AgentFailureCode.WorkflowStageFailed,
          }),
          stageCount: workflow.stages.length,
          completedStages: results.filter(r => r.success).length,
          failedStages: Math.max(1, workflow.stages.length - results.filter(r => r.success).length),
          stages: results.map((result) => ({
            name: result.stage,
            role: result.role,
            success: result.success,
            duration: result.duration,
            toolsUsed: result.context?.toolsUsed ?? [],
            toolPolicy: result.context?.toolPolicy,
            error: result.error,
            failureCode: result.failureCode,
          })),
        },
      };
    }
}

// ============================================================================
// GAP-004: 多 Agent 流水线反死循环
// 1. stage 失败 → 自动重试至 maxRetries（默认 WORKFLOW_ANTI_LOOP.DEFAULT_MAX_RETRIES）
// 2. 重试耗尽 + 配置了 onFailureRoute → 回退路由：重跑上游阶段拿新上下文，再给本阶段最后一次机会
//    （课程原则：Verifier 失败时回退到 Analyzer 而非让 Fixer 再试一次）
// 3. 同一 run 总回退次数超过 MAX_TOTAL_FALLBACKS → circuit breaker 跳闸：终止 workflow + 通知用户
// ============================================================================

interface WorkflowAntiLoopState {
  /** 同一 workflow run 内累计的回退（onFailureRoute）次数 */
  totalFallbacks: number;
  /** circuit breaker 是否已跳闸 */
  breakerTripped: boolean;
  /** 跳闸原因（用于 workflow 级错误信息） */
  breakerReason?: string;
}

/** 向用户发通知（cowork 产品的"人工介入"= 弹给用户）；emit 不可用时静默降级为日志 */
function notifyWorkflowUser(context: ToolContext, message: string): void {
  try {
    (context.emit as unknown as ((event: string, payload: unknown) => void) | undefined)?.(
      'notification',
      { message },
    );
  } catch {
    /* emit 信道不可用时仅日志兜底 */
  }
  logger.warn(`[Workflow] ${message}`);
}

/**
 * 带反死循环保护的 stage 执行：重试 → 回退路由 → circuit breaker。
 */
async function executeStageWithAntiLoop(
  stage: WorkflowStage,
  task: string,
  stageContexts: Map<string, StageContext>,
  roles: Record<string, { name: string; systemPrompt: string; tools: string[] }>,
  context: ToolContext,
  allStages: WorkflowStage[],
  antiLoop: WorkflowAntiLoopState,
): Promise<StageResult> {
  const maxRetries = stage.maxRetries ?? WORKFLOW_ANTI_LOOP.DEFAULT_MAX_RETRIES;

  // 初次执行 + 最多 maxRetries 次同阶段重试
  let lastResult: StageResult | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      logger.info('[Workflow] stage 失败重试', { stage: stage.name, attempt, maxRetries });
    }
    lastResult = await executeStage(stage, task, stageContexts, roles, context);
    if (lastResult.success) {
      return lastResult;
    }
  }
  const failedResult = lastResult as StageResult;

  // 重试耗尽：无回退路由 → 按失败返回（保持原有"失败不阻塞后续阶段"语义）
  if (!stage.onFailureRoute) {
    return failedResult;
  }

  const routeTarget = allStages.find((candidate) => candidate.name === stage.onFailureRoute);
  if (!routeTarget) {
    logger.warn('[Workflow] onFailureRoute 指向不存在的阶段，跳过回退', {
      stage: stage.name,
      route: stage.onFailureRoute,
    });
    return failedResult;
  }

  // 回退前先过 circuit breaker：总回退次数超限 → 跳闸
  antiLoop.totalFallbacks++;
  if (antiLoop.totalFallbacks > WORKFLOW_ANTI_LOOP.MAX_TOTAL_FALLBACKS) {
    antiLoop.breakerTripped = true;
    antiLoop.breakerReason =
      `阶段 ${stage.name} 重试 ${maxRetries} 次后仍失败，且 workflow 总回退次数已超上限 ` +
      `(${WORKFLOW_ANTI_LOOP.MAX_TOTAL_FALLBACKS})，circuit breaker 跳闸`;
    notifyWorkflowUser(
      context,
      `Workflow circuit breaker 跳闸：${antiLoop.breakerReason}。已暂停执行，请人工介入。`,
    );
    return {
      ...failedResult,
      error: `${failedResult.error ?? 'Stage failed'} [circuit breaker tripped]`,
    };
  }

  // 回退路由：重跑上游阶段（刷新其上下文），再给本阶段最后一次机会
  logger.info('[Workflow] 回退路由：重跑上游阶段', {
    stage: stage.name,
    route: stage.onFailureRoute,
    totalFallbacks: antiLoop.totalFallbacks,
  });
  notifyWorkflowUser(context, `阶段 ${stage.name} 多次失败，回退到上游阶段 ${stage.onFailureRoute} 重新执行`);

  const routeResult = await executeStage(routeTarget, task, stageContexts, roles, context);
  if (routeResult.success && routeResult.context) {
    stageContexts.set(routeTarget.name, routeResult.context);
  } else {
    logger.warn('[Workflow] 回退的上游阶段也失败了，按原失败结果返回', {
      stage: stage.name,
      route: stage.onFailureRoute,
    });
    return failedResult;
  }

  return executeStage(stage, task, stageContexts, roles, context);
}

// Build execution groups based on dependencies
function buildExecutionGroups(stages: WorkflowStage[]): WorkflowStage[][] {
  const groups: WorkflowStage[][] = [];
  const completed = new Set<string>();
  const remaining = [...stages];

  while (remaining.length > 0) {
    // Find stages whose dependencies are satisfied
    const ready = remaining.filter((stage) => {
      if (!stage.dependsOn || stage.dependsOn.length === 0) {
        return true;
      }
      return stage.dependsOn.every((dep) => completed.has(dep));
    });

    if (ready.length === 0) {
      // Circular dependency or invalid workflow
      throw new Error('Circular dependency or unsatisfied dependencies in workflow');
    }

    groups.push(ready);

    // Mark as completed and remove from remaining
    for (const stage of ready) {
      completed.add(stage.name);
      const idx = remaining.indexOf(stage);
      if (idx !== -1) {
        remaining.splice(idx, 1);
      }
    }
  }

  return groups;
}

// Resolve agent configuration from predefined agents or legacy roles
function resolveAgentConfig(
  roleOrId: string,
  legacyRoles: Record<string, { name: string; systemPrompt: string; tools: string[] }>
): {
  name: string;
  systemPrompt: string;
  tools: string[];
  model?: FullAgentConfig['model'];
  resolvedRole: string;
  originalRole?: string;
} | undefined {
  const { role: resolvedRole, originalRole } = normalizeWorkflowRole(roleOrId);

  // Check predefined agents (all agents are now unified here)
  try {
    const predefined = getPredefinedAgent(resolvedRole);
    if (predefined) {
      return {
        name: predefined.name,
        systemPrompt: getAgentPrompt(predefined),
        tools: getAgentTools(predefined),
        model: predefined.model,
        resolvedRole,
        originalRole,
      };
    }
  } catch (error) {
    logger.debug('[Workflow] 预定义 agent 解析失败，尝试 legacy role', {
      role: roleOrId,
      resolvedRole,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fall back to legacy roles (for backward compatibility)
  const legacy = legacyRoles[resolvedRole] ?? legacyRoles[roleOrId];
  if (legacy) {
    return {
      name: legacy.name,
      systemPrompt: legacy.systemPrompt,
      tools: legacy.tools,
      resolvedRole,
      originalRole,
    };
  }

  return undefined;
}

/**
 * GAP-016: 校验阶段输出是否符合声明的 outputSchema。
 * 无结构化数据 = 失败（声明了 schema 就必须产出可解析的 JSON）。
 */
function validateStageOutput(
  structuredData: Record<string, unknown> | undefined,
  outputSchema: Record<string, unknown>,
): { passed: boolean; errors: string[] } {
  if (!structuredData) {
    return {
      passed: false,
      errors: ['Stage declared an outputSchema but no JSON could be extracted from its output'],
    };
  }
  const result = validateAgainstSchema(structuredData, outputSchema as unknown as JsonSchema);
  return { passed: result.valid, errors: result.errors };
}

// Execute a single stage
async function executeStage(
  stage: WorkflowStage,
  task: string,
  previousContexts: Map<string, StageContext>,
  roles: Record<string, { name: string; systemPrompt: string; tools: string[] }>,
  context: ToolContext
): Promise<StageResult> {
  const startTime = Date.now();

  logger.info('[Stage] 开始执行阶段', { stage: stage.name, role: stage.role });

  const agentConfig = resolveAgentConfig(stage.role, roles);
  if (!agentConfig) {
    logger.error('[Stage] 未找到 agent 配置', { role: stage.role });
    return {
      stage: stage.name,
      role: stage.role,
      success: false,
      output: '',
      error: `Unknown role: ${stage.role}. Use predefined agents or legacy roles.`,
      failureCode: AgentFailureCode.ToolUnavailable,
      duration: 0,
    };
  }

  logger.info('[Stage] Agent 配置已解析', {
    stage: stage.name,
    agentName: agentConfig.name,
    role: stage.role,
    resolvedRole: agentConfig.resolvedRole,
    originalRole: agentConfig.originalRole,
    tools: agentConfig.tools,
    modelTier: agentConfig.model,
  });

  const toolPolicyResult = resolveStageToolPolicy(
    stage,
    agentConfig.tools,
    context.resolver as ToolResolver | undefined,
  );
  if (toolPolicyResult.error || !toolPolicyResult.policy) {
    return {
      stage: stage.name,
      role: stage.role,
      success: false,
      output: '',
      error: toolPolicyResult.error ?? 'Failed to resolve stage tool policy',
      failureCode: AgentFailureCode.ToolUnavailable,
      duration: Date.now() - startTime,
    };
  }

  const stageToolPolicy = toolPolicyResult.policy;
  const stageTimeoutResult = resolveStageExecutionTimeout(stage);
  if (stageTimeoutResult.error) {
    return {
      stage: stage.name,
      role: stage.role,
      success: false,
      output: '',
      error: stageTimeoutResult.error,
      failureCode: AgentFailureCode.Timeout,
      duration: Date.now() - startTime,
    };
  }

  logger.info('[Stage] 工具策略已解析', {
    stage: stage.name,
    mode: stageToolPolicy.mode,
    availableTools: stageToolPolicy.availableTools,
    blockedTools: stageToolPolicy.blockedTools,
    maxToolCalls: stageToolPolicy.maxToolCalls,
    maxExecutionTimeMs: stageTimeoutResult.maxExecutionTimeMs,
  });

  // Build context from previous stages - 使用结构化上下文
  let contextFromPrevious = '';
  if (stage.dependsOn && stage.dependsOn.length > 0) {
    const previousResults: string[] = [];

    for (const dep of stage.dependsOn) {
      const prevContext = previousContexts.get(dep);
      if (!prevContext) continue;

      let depOutput = `## ${dep} Output:\n`;

      // 1. 如果有结构化数据，优先使用 JSON 格式
      if (prevContext.structuredData) {
        depOutput += '### Structured Data (JSON):\n';
        depOutput += '```json\n';
        depOutput += JSON.stringify(prevContext.structuredData, null, 2);
        depOutput += '\n```\n\n';
      }

      // 2. 添加生成的文件信息
      if (prevContext.generatedFiles && prevContext.generatedFiles.length > 0) {
        depOutput += '### Generated Files:\n';
        for (const file of prevContext.generatedFiles) {
          depOutput += `- [${file.type}] ${file.path}\n`;
        }
        depOutput += '\n';
      }

      // 3. 添加文本输出（如果没有结构化数据）
      if (!prevContext.structuredData && prevContext.textOutput) {
        depOutput += '### Text Output:\n';
        depOutput += prevContext.textOutput;
        depOutput += '\n';
      }

      previousResults.push(depOutput);
    }

    if (previousResults.length > 0) {
      contextFromPrevious = `\n\n---\n**Context from previous stages:**\n\n${previousResults.join('\n\n')}`;
    }
  }

  // GAP-016: 声明了 outputSchema 的阶段，把 schema 要求写进 prompt，让子代理知道输出契约
  const outputSchemaRequirement = stage.outputSchema
    ? [
        '',
        '',
        '**Output Schema Requirement:** 你的最终输出必须包含一个 ```json 代码块，其内容符合以下 JSON Schema：',
        '```json',
        JSON.stringify(stage.outputSchema, null, 2),
        '```',
      ].join('\n')
    : '';

  const fullPrompt = `${stage.prompt}

**Overall Task:** ${task}${contextFromPrevious}${outputSchemaRequirement}`;

  try {
    const executor = getSubagentExecutor();

    const effectiveModelConfig = resolveStageModelConfig(
      context.modelConfig as ModelConfig,
      agentConfig.model,
      stage.name,
    );

    // Pass attachments to subagent for multimodal processing (e.g., images for vision models)
    const attachments = context.currentAttachments;
    if (attachments && attachments.length > 0) {
      logger.info('[Stage] Passing attachments to subagent', {
        stage: stage.name,
        attachmentCount: attachments.length,
        types: attachments.map(a => a.type),
      });
    }

    const result = await executor.execute(
      fullPrompt,
      {
        name: `Stage:${stage.name}`,
        systemPrompt: agentConfig.systemPrompt,
        availableTools: stageToolPolicy.availableTools,
        maxIterations: 15,
        maxToolCalls: stageToolPolicy.maxToolCalls,
        maxExecutionTimeMs: stageTimeoutResult.maxExecutionTimeMs,
      },
      {
        modelConfig: effectiveModelConfig,
        toolResolver: context.resolver as ToolResolver,
        toolContext: context,
        parentToolUseId: context.currentToolCallId,
        abortSignal: context.abortSignal,
        hookManager: context.hookManager,
        // Pass attachments for multimodal support
        attachments: attachments,
      }
    );

    const duration = Date.now() - startTime;

    // 构建结构化上下文
    const stageContext: StageContext = {
      textOutput: result.output,
      structuredData: extractStructuredData(result.output),
      generatedFiles: extractGeneratedFiles(result.output),
      toolsUsed: result.toolsUsed || [],
      toolPolicy: stageToolPolicy,
      duration,
    };

    // GAP-016: 输出端质量检查点——校验失败按阶段失败处理，不让下游拿脏数据
    let outputValidationError: string | undefined;
    if (stage.outputSchema && result.success) {
      const validation = validateStageOutput(stageContext.structuredData, stage.outputSchema);
      stageContext.validationResult = validation;
      if (!validation.passed) {
        outputValidationError =
          `Stage output failed schema validation: ${validation.errors.join('; ')}`;
        logger.warn('[Stage] 输出 schema 校验失败', {
          stage: stage.name,
          errors: validation.errors,
        });
      }
    }

    const stageSuccess = result.success && !outputValidationError;

    logger.info('[Stage] 阶段执行完成', {
      stage: stage.name,
      success: stageSuccess,
      duration,
      outputLength: result.output?.length || 0,
      hasStructuredData: !!stageContext.structuredData,
      generatedFilesCount: stageContext.generatedFiles?.length || 0,
      outputSchemaValidated: stage.outputSchema ? stageContext.validationResult?.passed : undefined,
    });

    return {
      stage: stage.name,
      role: stage.role,
      success: stageSuccess,
      output: result.output,
      error: outputValidationError ?? result.error,
      failureCode: stageSuccess
        ? undefined
        : outputValidationError
          ? AgentFailureCode.WorkflowStageFailed
          : result.failureCode
            ?? inferAgentFailureCode({
              cancellationReason: result.cancellationReason,
              error: result.error,
              defaultCode: AgentFailureCode.WorkflowStageFailed,
            }),
      duration,
      context: stageContext,
    };
  } catch (error) {
    logger.error('[Stage] 阶段执行异常', {
      stage: stage.name,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      stage: stage.name,
      role: stage.role,
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error',
      failureCode: inferAgentFailureCode({
        error,
        defaultCode: AgentFailureCode.WorkflowStageFailed,
      }),
      duration: Date.now() - startTime,
      context: {
        textOutput: '',
        toolsUsed: [],
        toolPolicy: stageToolPolicy,
        duration: Date.now() - startTime,
      },
    };
  }
}

// Export function to list available workflows
export function getAvailableWorkflows(): Record<string, WorkflowTemplate> {
  return { ...BUILT_IN_WORKFLOWS };
}

// WorkflowOrchestrate (PascalCase variant) — migrated to native;
// 当前 protocol 只暴露 'workflow_orchestrate'，未来如需 PascalCase entry 可加
// 一条 register 直连到 modules/multiagent/workflowOrchestrate 同 module。
