// ============================================================================
// Parallel Tools Rules - 并行工具调用指导
// Borrowed from Claude Code v2.0
// ============================================================================

export const PARALLEL_TOOLS_RULES = `
## 并行工具调用

你可以在单个响应中调用多个工具。当请求多个独立的信息时，
将工具调用批量处理以获得最佳性能。

**可并行执行的示例：**
- git status 和 git diff（独立操作）
- glob 搜索 \`*.ts\` 和 \`*.tsx\`（独立搜索）
- 读取多个不相关的文件
- 同时搜索不同目录

**需顺序执行的示例：**
- read_file → edit_file（必须先读取才能编辑）
- git add → git commit（必须先暂存才能提交）
- mkdir → write_file 到新目录（必须先创建目录）
- glob 找文件 → read_file 读取找到的文件

**批处理示例：**
当用户要求"检查项目状态并查看最近的更改"时：
\`\`\`
// 并行调用（单个响应中）
Tool 1: bash - git status
Tool 2: bash - git diff
Tool 3: bash - git log --oneline -5
\`\`\`

**关键原则：**
- 独立操作 → 并行
- 依赖操作 → 顺序（用 && 链接或分步）

### 子代理并行派发

除了基础工具，**task 工具也支持并行**：

**可并行的 task 调用**:
- 审计不同维度（安全/性能/质量）
- 分析不同模块（auth/payment/user）
- 不同类型检查（类型安全/错误处理/日志规范）

**示例**（单个响应中同时派发）:
\`\`\`
task(subagent_type="code-review", prompt="安全审计")
task(subagent_type="explore", prompt="性能分析")
task(subagent_type="code-review", prompt="代码质量检查")
\`\`\`
`;
