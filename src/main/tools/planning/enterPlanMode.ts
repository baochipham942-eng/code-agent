// ============================================================================
// Enter Plan Mode Tool - 进入规划模式
// Borrowed from Claude Code v2.0
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';

export const enterPlanModeTool: Tool = {
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
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: '进入规划模式的原因（可选）',
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const reason = (params.reason as string) || '复杂任务需要前期规划';

    // 设置规划模式状态
    if (context.setPlanMode) {
      context.setPlanMode(true);
    }

    // 发送事件通知前端（如果有）
    if (context.emitEvent) {
      context.emitEvent('planModeChanged', { active: true, reason });
    }

    const output = `## 📋 已进入规划模式

**原因：** ${reason}

**当前阶段：** 探索与设计

### 你现在应该：
1. 使用 \`glob\`、\`grep\`、\`read_file\` 探索代码库
2. 理解现有架构和模式
3. 设计实现方案
4. 完成后使用 \`exit_plan_mode\` 提交计划

### 规划模式期间：
- ✅ 可以：读取文件、搜索代码、分析架构
- ❌ 避免：执行写入操作、提交代码

准备好计划后，调用 \`exit_plan_mode\` 并提供详细的实现计划。`;

    return {
      success: true,
      output,
    };
  },
};
