// ============================================================================
// Task Tool Description - Detailed usage guide for the task tool
// ============================================================================

/**
 * 详细的 Task 工具描述
 *
 * 精简版，强调同步委派边界
 * 约 400 tokens
 */
import { applyOverride } from '../registry';

export const TASK_TOOL_DESCRIPTION = applyOverride(
  { id: 'tools.task', category: '工具描述', name: 'Task 工具描述', description: 'Task subagent 工具的 prompt 描述' },
  `
## Task 工具

启动一个子代理同步处理单个明确任务。工具名是 **Task**。目标文件和编辑区域已经明确时，直接用读写工具完成，不要为了单点修改再委派。

### 子代理类型

| 类型 | 用途 |
|------|------|
| explore | 探索代码库、理解架构、查找实现 |
| reviewer | 代码审查、安全审计、质量检查 |
| coder | 代码编写、修复、重构 |
| plan | 设计方案、任务分解、架构规划 |
| awaiter | 长命令等待、测试监控 |

### 和其他多代理工具的边界

- **Task**：一个子代理、同步等待结果、适合单次探索/审查/实现
- **AgentSpawn**：并行、后台、自定义工具/提示词、预算控制
- **workflow**：用 JS 编排多代理 fan-out/fan-in、循环、流水线

### 使用示例

\`\`\`json
{
  "description": "Explore auth",
  "subagent_type": "explore",
  "prompt": "找到所有处理用户认证的文件"
}
\`\`\`

\`\`\`json
{
  "description": "Review auth",
  "subagent_type": "reviewer",
  "prompt": "审查 src/auth/ 的安全性"
}
\`\`\`
`,
);
