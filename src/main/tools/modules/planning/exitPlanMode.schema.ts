// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const exitPlanModeSchema: ToolSchema = {
  name: 'exit_plan_mode',
  description: `退出规划模式，向用户呈现实现计划以供审批。

**何时使用：**
- 已完成代码探索
- 已设计好实现方案
- 准备好供用户审批

**何时不用：**
- 纯研究/探索任务
- 简单的信息查询
- 尚未完成规划

**计划应包含：**
- 修改的文件清单
- 每个文件的修改内容概述
- 实现步骤（按顺序）
- 潜在风险或注意事项`,
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: '实现计划（支持 Markdown 格式），应包含文件清单、修改内容和实现步骤',
      },
    },
    required: ['plan'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};
