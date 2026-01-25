// ============================================================================
// Workflow Orchestrate Tool - Orchestrate multi-agent workflows
// Gen 7: Multi-Agent capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type { ModelConfig, ModelProvider } from '../../../shared/types';
import { getSubagentExecutor } from '../../agent/subagentExecutor';
import { getAvailableRoles } from './spawnAgent';
import { getPredefinedAgent, type AgentDefinition } from '../../agent/agentDefinition';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('WorkflowOrchestrate');

// Predefined workflow templates
const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  'code-review-pipeline': {
    name: 'Code Review Pipeline',
    description: 'Coder -> Reviewer -> Tester flow for feature development',
    stages: [
      {
        name: 'Development',
        role: 'coder',
        prompt: 'Implement the feature as specified.',
      },
      {
        name: 'Review',
        role: 'reviewer',
        prompt: 'Review the code written in the previous stage. List issues found.',
        dependsOn: ['Development'],
      },
      {
        name: 'Testing',
        role: 'tester',
        prompt: 'Write tests for the implemented feature.',
        dependsOn: ['Development'],
      },
    ],
  },
  'bug-fix-flow': {
    name: 'Bug Fix Flow',
    description: 'Debugger -> Coder -> Tester flow for bug fixes',
    stages: [
      {
        name: 'Investigation',
        role: 'debugger',
        prompt: 'Investigate the bug and identify the root cause.',
      },
      {
        name: 'Fix',
        role: 'coder',
        prompt: 'Implement the fix based on the investigation results.',
        dependsOn: ['Investigation'],
      },
      {
        name: 'Verification',
        role: 'tester',
        prompt: 'Write tests to verify the fix and prevent regression.',
        dependsOn: ['Fix'],
      },
    ],
  },
  'documentation-flow': {
    name: 'Documentation Flow',
    description: 'Architect -> Documenter flow for documentation',
    stages: [
      {
        name: 'Architecture Analysis',
        role: 'architect',
        prompt: 'Analyze the system architecture and key components.',
      },
      {
        name: 'Documentation',
        role: 'documenter',
        prompt: 'Write comprehensive documentation based on the architecture analysis.',
        dependsOn: ['Architecture Analysis'],
      },
    ],
  },
  'parallel-review': {
    name: 'Parallel Review',
    description: 'Run reviewer and tester in parallel',
    stages: [
      {
        name: 'Code Review',
        role: 'reviewer',
        prompt: 'Review the code for quality and issues.',
      },
      {
        name: 'Test Writing',
        role: 'tester',
        prompt: 'Write comprehensive tests.',
      },
    ],
  },
  'image-annotation': {
    name: '图片标注流程',
    description: '视觉理解 -> 视觉处理：先识别图片内容和位置，再进行标注',
    stages: [
      {
        name: '视觉理解',
        role: 'visual-understanding',
        prompt: `分析图片内容，识别所有需要标注的元素。

输出格式要求：
1. 列出所有识别到的元素
2. 为每个元素提供位置信息（如：左上角、中央、右下角，或百分比坐标）
3. 描述元素的大致尺寸（相对于图片的占比）

注意：位置信息要尽可能精确，以便后续标注处理。`,
      },
      {
        name: '视觉处理',
        role: 'visual-processing',
        prompt: `根据视觉理解阶段的分析结果，在图片上绘制标注。

使用 image_annotate 工具进行标注绘制：
- 根据识别到的位置信息计算坐标
- 选择合适的标注类型（矩形框、圆圈、箭头等）
- 添加必要的标签文字

确保所有识别到的元素都被正确标注。`,
        dependsOn: ['视觉理解'],
      },
    ],
  },
  'image-ocr-annotate': {
    name: 'OCR 文字标注流程',
    description: '专门用于识别图片中的文字并用矩形框标注',
    stages: [
      {
        name: 'OCR 识别',
        role: 'visual-understanding',
        prompt: `识别图片中的所有文字区域。

输出格式要求：
1. 列出每个文字区域的内容
2. 提供每个文字区域的位置（x%, y% 相对于图片左上角）
3. 提供每个文字区域的大小（宽度%、高度%）
4. 按从上到下、从左到右的阅读顺序排列

示例输出格式：
- 文字1: "标题文字", 位置: (10%, 5%), 尺寸: (80%, 8%)
- 文字2: "正文内容", 位置: (10%, 20%), 尺寸: (60%, 5%)`,
      },
      {
        name: '矩形标注',
        role: 'visual-processing',
        prompt: `根据 OCR 识别结果，用矩形框标注所有文字区域。

使用 image_annotate 工具：
- 将百分比坐标转换为像素坐标（假设图片尺寸，或使用相对坐标）
- 为每个文字区域绘制矩形框
- 矩形框颜色使用红色(#FF0000)
- 可选：添加标签显示文字内容

确保标注清晰可见，不遮挡原文字。`,
        dependsOn: ['OCR 识别'],
      },
    ],
  },
};

interface WorkflowStage {
  name: string;
  role: string;
  prompt: string;
  dependsOn?: string[];
}

interface WorkflowTemplate {
  name: string;
  description: string;
  stages: WorkflowStage[];
}

interface StageResult {
  stage: string;
  role: string;
  success: boolean;
  output: string;
  error?: string;
  duration: number;
}

export const workflowOrchestrateTool: Tool = {
  name: 'workflow_orchestrate',
  description: `协调多个专业 Agent 完成需要多步骤协作的复杂任务。

**何时使用此工具**：
当任务需要"先理解后处理"或"多种能力协作"时使用。

**核心判断逻辑**：
1. 任务是否需要多个不同能力的步骤？（如：识别 → 标注）
2. 任务是否需要不同类型的模型？（如：视觉模型 → 工具调用模型）
3. 前一步的输出是否是后一步的输入？

**可用工作流**：
- image-ocr-annotate: 图片文字识别 + 标注绘制
- image-annotation: 图片元素识别 + 标注绘制
- code-review-pipeline: 代码编写 + 审查 + 测试
- bug-fix-flow: 问题诊断 + 修复 + 验证

**参数**：
- workflow: 选择合适的工作流模板
- task: 用户的原始任务描述`,
  generations: ['gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        description: 'Workflow template name or "custom"',
      },
      task: {
        type: 'string',
        description: 'The task to accomplish',
      },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            prompt: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'role', 'prompt'],
        },
        description: 'Custom workflow stages',
      },
      parallel: {
        type: 'boolean',
        description: 'Run independent stages in parallel',
      },
    },
    required: ['workflow', 'task'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const workflowName = params.workflow as string;
    const task = params.task as string;
    const customStages = params.stages as WorkflowStage[] | undefined;
    const parallel = params.parallel !== false;

    // Check for required context
    if (!context.toolRegistry || !context.modelConfig) {
      return {
        success: false,
        error: 'workflow_orchestrate requires toolRegistry and modelConfig in context',
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
      workflow = WORKFLOW_TEMPLATES[workflowName];
      if (!workflow) {
        return {
          success: false,
          error: `Unknown workflow: ${workflowName}. Available: ${Object.keys(WORKFLOW_TEMPLATES).join(', ')}`,
        };
      }
    }

    const roles = getAvailableRoles();
    const results: StageResult[] = [];
    const stageOutputs: Map<string, string> = new Map();

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
            group.map((stage) => executeStage(stage, task, stageOutputs, roles, context))
          );

          for (let i = 0; i < group.length; i++) {
            results.push(groupResults[i]);
            if (groupResults[i].success) {
              stageOutputs.set(group[i].name, groupResults[i].output);
            }
          }
        } else {
          // Execute stages sequentially
          for (const stage of group) {
            const result = await executeStage(stage, task, stageOutputs, roles, context);
            results.push(result);
            if (result.success) {
              stageOutputs.set(stage.name, result.output);
            }
          }
        }
      }

      // Build summary
      const successCount = results.filter(r => r.success).length;
      const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

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
      };
    } catch (error) {
      return {
        success: false,
        error: `Workflow failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

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

// Resolve agent configuration from either predefined agents or legacy roles
function resolveAgentConfig(
  roleOrId: string,
  legacyRoles: Record<string, { name: string; systemPrompt: string; tools: string[] }>
): { name: string; systemPrompt: string; tools: string[]; modelOverride?: AgentDefinition['modelOverride'] } | undefined {
  // First check predefined agents (new system)
  const predefined = getPredefinedAgent(roleOrId);
  if (predefined) {
    return {
      name: predefined.name,
      systemPrompt: predefined.systemPrompt,
      tools: predefined.tools,
      modelOverride: predefined.modelOverride,
    };
  }

  // Fall back to legacy roles
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
  previousOutputs: Map<string, string>,
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
    hasModelOverride: !!agentConfig.modelOverride,
  });

  // Build context from previous stages
  let contextFromPrevious = '';
  if (stage.dependsOn && stage.dependsOn.length > 0) {
    const previousResults = stage.dependsOn
      .map((dep) => {
        const output = previousOutputs.get(dep);
        return output ? `## ${dep} Output:\n${output}` : null;
      })
      .filter(Boolean)
      .join('\n\n');

    if (previousResults) {
      contextFromPrevious = `\n\n---\nContext from previous stages:\n${previousResults}`;
    }
  }

  const fullPrompt = `${stage.prompt}

Overall Task: ${task}${contextFromPrevious}`;

  try {
    const executor = getSubagentExecutor();

    // Apply model override if specified
    let effectiveModelConfig = context.modelConfig as ModelConfig;
    if (agentConfig.modelOverride) {
      effectiveModelConfig = {
        ...effectiveModelConfig,
        provider: (agentConfig.modelOverride.provider as ModelProvider) || effectiveModelConfig.provider,
        model: agentConfig.modelOverride.model || effectiveModelConfig.model,
        temperature: agentConfig.modelOverride.temperature ?? effectiveModelConfig.temperature,
      };
      logger.info('Using model override for stage', {
        stage: stage.name,
        provider: effectiveModelConfig.provider,
        model: effectiveModelConfig.model,
      });
    }

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
        toolRegistry: new Map(
          context.toolRegistry!.getAllTools().map((t) => [t.name, t])
        ),
        toolContext: context,
        // Pass attachments for multimodal support
        attachments: attachments,
      }
    );

    logger.info('[Stage] 阶段执行完成', {
      stage: stage.name,
      success: result.success,
      duration: Date.now() - startTime,
      outputLength: result.output?.length || 0,
    });

    return {
      stage: stage.name,
      role: stage.role,
      success: result.success,
      output: result.output,
      error: result.error,
      duration: Date.now() - startTime,
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
  return { ...WORKFLOW_TEMPLATES };
}
