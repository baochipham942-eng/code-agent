// Schema-only file (P1 Wave 3 — multiagent native migration)
import type { ToolSchema } from '../../../protocol/tools';
import { listBuiltInWorkflows } from '../../../../shared/contract/workflow';

const buildDescription = (): string => `协调多个专业 Agent 完成需要多步骤协作的复杂任务。

**何时使用此工具**：
当任务需要"先理解后处理"或"多种能力协作"时使用。

**核心判断逻辑**：
1. 任务是否需要多个不同能力的步骤？（如：识别 → 标注）
2. 任务是否需要不同类型的模型？（如：视觉模型 → 工具调用模型）
3. 前一步的输出是否是后一步的输入？

**可用工作流**：
${listBuiltInWorkflows().map((w) => `- ${w.id}: ${w.description}`).join('\n')}

**参数**：
- workflow: 选择合适的工作流模板
- task: 用户的原始任务描述`;

export const workflowOrchestrateSchema: ToolSchema = {
  name: 'workflow_orchestrate',
  description: buildDescription(),
  dynamicDescription: buildDescription,
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
  category: 'multiagent',
  permissionLevel: 'execute',
};
