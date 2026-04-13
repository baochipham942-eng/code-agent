// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const enterPlanModeSchema: ToolSchema = {
  name: 'enter_plan_mode',
  description: `进入规划模式，用于复杂实现任务的前期设计。

**何时使用：**
- 新功能实现（不是简单修改）
- 存在多种有效方案需要选择
- 需要架构决策
- 涉及多文件修改（>3 个文件）
- 需求不明确，需要先探索

**何时跳过：**
- 单行或少量修改（错别字、简单 bug）
- 需求明确的单函数添加
- 用户给出了详细具体的指令

进入后你将专注于探索和设计，完成后使用 exit_plan_mode 提交计划供用户审批。`,
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: '进入规划模式的原因（可选）',
      },
    },
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};
