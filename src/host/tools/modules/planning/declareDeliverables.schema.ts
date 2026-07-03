// Schema-only file — 最终产物路径声明工具
import type { ToolSchema } from '../../../protocol/tools';

const DECLARE_DELIVERABLES_DESCRIPTION = `在产物生成/修复任务开始时调用本工具，声明本次任务的最终交付文件路径，以及可选的草稿/中间产物目录。

这个声明会成为后续产物校验、路径锚定、修复锁定和工作区卫生检查的统一依据，避免同一任务在不同轮次里把最终文件漂移成不同路径。

使用规则：
- 开工第一步调用一次，声明 final_artifacts；
- 后续写入、验证和收尾都应对齐这些最终路径；
- 如果任务范围确实变化，可以再次调用本工具覆盖之前的声明，系统会明确提示已覆盖旧声明。

参数：
- final_artifacts：最终交付产物文件路径清单（相对工作目录或绝对路径），不能为空。
- scratch_dir：可选，草稿/中间产物目录；写在这里的临时文件会被视为有归属。`;

export const declareDeliverablesSchema: ToolSchema = {
  name: 'declare_deliverables',
  description: DECLARE_DELIVERABLES_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      final_artifacts: {
        type: 'array',
        items: { type: 'string' },
        description: '最终交付产物文件路径清单（相对工作目录或绝对路径）',
      },
      scratch_dir: {
        type: 'string',
        description: '可选的草稿/中间产物目录',
      },
    },
    required: ['final_artifacts'],
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: false,
};
