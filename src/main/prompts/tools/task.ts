// ============================================================================
// Task Tool Description - Detailed usage guide for the task tool
// ============================================================================

/**
 * 详细的 Task 工具描述
 *
 * 精简版，强调并行派发能力
 * 约 400 tokens
 */
import { applyOverride } from '../registry';

export const TASK_TOOL_DESCRIPTION = applyOverride(
  { id: 'tools.task', category: '工具描述', name: 'Task 工具描述', description: 'Task subagent 工具的 prompt 描述' },
  `
## Task 工具

启动子代理处理复杂任务。工具名是 **Task**。目标文件和编辑区域已经明确时，直接用读写工具完成，不要为了单点修改再委派。

### 子代理类型

| 类型 | 用途 |
|------|------|
| explore | 探索代码库、理解架构、查找实现 |
| reviewer | 代码审查、安全审计、质量检查 |
| coder | 代码编写、修复、重构 |
| plan | 设计方案、任务分解、架构规划 |
| awaiter | 长命令等待、测试监控 |

### 并行派发（重要）

当任务包含多个独立维度时，**同时派发多个 Task**：

\`\`\`
// 在单个响应中并行派发
Task(subagent_type="reviewer", prompt="安全审计：扫描 API 认证问题")
Task(subagent_type="explore", prompt="性能分析：找出 N+1 查询")
Task(subagent_type="reviewer", prompt="代码质量：检查 any 类型")
\`\`\`

**并行场景**：
- 安全 + 性能 + 质量审计
- 前端 + 后端 + 数据库层分析
- 多个独立模块的探索

### 使用示例

\`\`\`json
Task {
  "subagent_type": "explore",
  "prompt": "找到所有处理用户认证的文件"
}
\`\`\`

\`\`\`json
Task {
  "subagent_type": "reviewer",
  "prompt": "审查 src/auth/ 的安全性"
}
\`\`\`
`,
);
