// ============================================================================
// Exit Plan Mode Tool - 退出规划模式
// Borrowed from Claude Code v2.0
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

export const exitPlanModeTool: Tool = {
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
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
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

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const plan = params.plan as string;

    if (!plan || plan.trim().length === 0) {
      return {
        success: false,
        error: '请提供实现计划。计划应包含修改的文件清单、修改内容和实现步骤。',
      };
    }

    // 退出规划模式
    if (context.setPlanMode) {
      context.setPlanMode(false);
    }

    // 发送事件通知前端
    if (context.emitEvent) {
      context.emitEvent('planModeChanged', { active: false, plan });
    }

    const output = `## 📋 实现计划

${plan}

---

### ⏳ 等待确认

请审阅上述计划，然后告诉我：
- **确认执行**：我将按计划开始实现
- **修改计划**：告诉我需要调整的部分
- **取消**：如果不需要继续`;

    return {
      success: true,
      output,
      // 标记需要用户确认
      metadata: {
        requiresUserConfirmation: true,
        confirmationType: 'plan_approval',
        plan,
      },
    };
  },
};
