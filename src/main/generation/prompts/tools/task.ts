// ============================================================================
// Task Tool Description - Detailed usage guide for the task tool
// ============================================================================

/**
 * 详细的 Task 工具描述
 *
 * 包含子代理类型说明、使用场景、最佳实践
 * 约 900 tokens
 */
export const TASK_TOOL_DESCRIPTION = `
## Task 工具详细指南

启动专门的子代理来处理复杂、多步骤的任务。通过委派可以提高效率和专注度。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| prompt | string | 是 | 交给子代理的任务描述 |
| subagent_type | string | 是 | 子代理类型（见下表）|
| run_in_background | boolean | 否 | 是否后台运行，默认 false |

### 子代理类型

| 类型 | 名称 | 专长 | 可用工具 |
|------|------|------|----------|
| explore | Explore | 快速探索代码库 | glob, grep, read_file, list_directory |
| bash | Bash | 命令执行 | bash |
| plan | Plan | 设计实现方案 | glob, grep, read_file, list_directory |
| code-review | Code Reviewer | 代码审查 | glob, grep, read_file |

### 何时使用

**使用 explore 子代理**：
- 查找特定代码（类、函数、变量）
- 理解代码库结构
- 回答"X 在哪里？"或"Y 是如何工作的？"

<example>
\`\`\`json
task {
  "subagent_type": "explore",
  "prompt": "找到处理用户认证的所有文件和函数"
}
\`\`\`
</example>

**使用 bash 子代理**：
- 执行构建、测试等命令
- 运行多步骤的命令行操作
- 需要检查命令输出并做出反应

<example>
\`\`\`json
task {
  "subagent_type": "bash",
  "prompt": "运行测试并报告失败的测试用例"
}
\`\`\`
</example>

**使用 plan 子代理**：
- 设计新功能的实现方案
- 规划重构步骤
- 评估不同技术方案

<example>
\`\`\`json
task {
  "subagent_type": "plan",
  "prompt": "设计一个用户通知系统，支持邮件和推送两种方式"
}
\`\`\`
</example>

**使用 code-review 子代理**：
- 审查代码变更
- 检查安全漏洞
- 评估代码质量

<example>
\`\`\`json
task {
  "subagent_type": "code-review",
  "prompt": "审查 src/auth/ 目录下的认证相关代码"
}
\`\`\`
</example>

### 何时不使用

| 场景 | 替代方案 |
|------|----------|
| 读取已知路径的文件 | 直接使用 read_file |
| 搜索已知的类名或函数 | 直接使用 glob 或 grep |
| 简单的单条命令 | 直接使用 bash |
| 编辑文件 | 直接使用 edit_file |

### 最佳实践

1. **提供清晰的任务描述**
   - 说明目标是什么
   - 提供必要的上下文
   - 指明期望的输出格式

2. **选择正确的子代理类型**
   - 搜索探索 → explore
   - 执行命令 → bash
   - 规划设计 → plan
   - 代码审查 → code-review

3. **并行使用多个子代理**
   - 独立的任务可以并行委派
   - 例如：同时探索前端和后端代码

4. **处理返回结果**
   - 子代理返回的是总结性结果
   - 需要详细信息时，根据结果进行后续操作

### 注意事项

- 子代理有迭代次数限制，超复杂任务可能需要拆分
- 子代理的工具是受限的，不能执行所有操作
- 后台运行功能尚在开发中
- 子代理不能访问当前对话的上下文
`;
