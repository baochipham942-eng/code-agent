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
} from '../../../shared/contract/workflow';
import {
  BUILT_IN_WORKFLOWS,
  getBuiltInWorkflow,
  listBuiltInWorkflows,
} from '../../../shared/contract/workflow';
import { getSubagentExecutor } from '../subagentExecutor';
import type { ToolResolver } from '../../tools/dispatch/toolResolver';
import {
  getPredefinedAgent,
  getAgentPrompt,
  getAgentTools,
  type FullAgentConfig,
} from '../agentDefinition';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('WorkflowOrchestrate');

const CLAUDE_STAGE_MODEL_BY_TIER: Record<Exclude<FullAgentConfig['model'], 'inherit' | undefined>, string> = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-4-6',
  powerful: 'claude-opus-4-7',
};

function resolveStageModelConfig(
  baseConfig: ModelConfig,
  tier: FullAgentConfig['model'] | undefined,
  stageName: string,
): ModelConfig {
  if (!tier || tier === 'inherit') {
    return baseConfig;
  }

  const claudeModel = CLAUDE_STAGE_MODEL_BY_TIER[tier];
  if (!claudeModel) {
    return baseConfig;
  }

  if (baseConfig.provider === 'claude') {
    logger.info('Using Claude model tier for stage', {
      stage: stageName,
      tier,
      model: claudeModel,
    });
    return {
      ...baseConfig,
      model: claudeModel,
    };
  }

  logger.info('Using inherited model for provider-incompatible stage tier', {
    stage: stageName,
    tier,
    provider: baseConfig.provider,
    model: baseConfig.model,
  });
  return baseConfig;
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
      };
    }

    // Get workflow definition
    let workflow: WorkflowTemplate;
    if (workflowName === 'custom') {
      if (!customStages || customStages.length === 0) {
        return {
          success: false,
          error: 'Custom workflow requires stages array',
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

      for (const group of executionGroups) {
        logger.info('[Workflow] 执行阶段组', { stages: group.map(s => s.name).join(', ') });

        if (parallel && group.length > 1) {
          // Execute stages in parallel
          const groupResults = await Promise.all(
            group.map((stage) => executeStage(stage, task, stageContexts, legacyRoles, context))
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
            const result = await executeStage(stage, task, stageContexts, legacyRoles, context);
            results.push(result);
            if (result.success && result.context) {
              stageContexts.set(stage.name, result.context);
            }
          }
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
      };
    } catch (error) {
      return {
        success: false,
        error: `Workflow failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
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
): { name: string; systemPrompt: string; tools: string[]; model?: FullAgentConfig['model'] } | undefined {
  // Check predefined agents (all agents are now unified here)
  const predefined = getPredefinedAgent(roleOrId);
  if (predefined) {
    return {
      name: predefined.name,
      systemPrompt: getAgentPrompt(predefined),
      tools: getAgentTools(predefined),
      model: predefined.model,
    };
  }

  // Fall back to legacy roles (for backward compatibility)
  const legacy = legacyRoles[roleOrId];
  if (legacy) {
    return {
      name: legacy.name,
      systemPrompt: legacy.systemPrompt,
      tools: legacy.tools,
    };
  }

  return undefined;
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
      duration: 0,
    };
  }

  logger.info('[Stage] Agent 配置已解析', {
    stage: stage.name,
    agentName: agentConfig.name,
    tools: agentConfig.tools,
    modelTier: agentConfig.model,
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

  const fullPrompt = `${stage.prompt}

**Overall Task:** ${task}${contextFromPrevious}`;

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
        availableTools: agentConfig.tools,
        maxIterations: 15,
      },
      {
        modelConfig: effectiveModelConfig,
        toolResolver: context.resolver as ToolResolver,
        toolContext: context,
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
      duration,
    };

    logger.info('[Stage] 阶段执行完成', {
      stage: stage.name,
      success: result.success,
      duration,
      outputLength: result.output?.length || 0,
      hasStructuredData: !!stageContext.structuredData,
      generatedFilesCount: stageContext.generatedFiles?.length || 0,
    });

    return {
      stage: stage.name,
      role: stage.role,
      success: result.success,
      output: result.output,
      error: result.error,
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
      duration: Date.now() - startTime,
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
