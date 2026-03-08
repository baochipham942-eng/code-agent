// ============================================================================
// Task Tool Description - Detailed usage guide for the task tool
// ============================================================================

/**
 * 详细的 Task 工具描述
 *
 * 精简版，强调并行派发能力
 * 约 400 tokens
 */
export const TASK_TOOL_DESCRIPTION = `
## Task 工具

启动子代理处理复杂任务。**支持并行派发多个子代理**。

### 子代理类型

| 类型 | 用途 |
|------|------|
| explore | 探索代码库、理解架构、查找实现 |
| code-review | 代码审查、安全审计、质量检查 |
| plan | 设计方案、任务分解、架构规划 |
| bash | 命令执行、构建、测试 |

### 并行派发（重要）

当任务包含多个独立维度时，**同时派发多个 task**：

\`\`\`
// 在单个响应中并行派发
task(subagent_type="code-review", prompt="安全审计：扫描 API 认证问题")
task(subagent_type="explore", prompt="性能分析：找出 N+1 查询")
task(subagent_type="code-review", prompt="代码质量：检查 any 类型")
\`\`\`

**并行场景**：
- 安全 + 性能 + 质量审计
- 前端 + 后端 + 数据库层分析
- 多个独立模块的探索

### 使用示例

\`\`\`json
task {
  "subagent_type": "explore",
  "prompt": "找到所有处理用户认证的文件"
}
\`\`\`

\`\`\`json
task {
  "subagent_type": "code-review",
  "prompt": "审查 src/auth/ 的安全性"
}
\`\`\`
`;
