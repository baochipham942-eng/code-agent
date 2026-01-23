// ============================================================================
// Bash Tool Description - Detailed usage guide for the bash tool
// ============================================================================

/**
 * 详细的 Bash 工具描述
 *
 * 包含参数说明、使用示例、注意事项等
 * 约 1200 tokens
 */
export const BASH_TOOL_DESCRIPTION = `
## Bash 工具详细指南

执行 shell 命令并返回结果。这是与操作系统交互的主要工具。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| command | string | 是 | 要执行的命令 |
| timeout | number | 否 | 超时时间（毫秒），默认 120000 |
| working_directory | string | 否 | 工作目录，默认为当前项目根目录 |

### 使用示例

<example>
**运行测试**
\`\`\`json
bash { "command": "npm test" }
\`\`\`
</example>

<example>
**检查 Git 状态**
\`\`\`json
bash { "command": "git status" }
\`\`\`
</example>

<example>
**安装依赖**
\`\`\`json
bash { "command": "npm install lodash" }
\`\`\`
</example>

<example>
**构建项目**
\`\`\`json
bash { "command": "npm run build" }
\`\`\`
</example>

<example>
**查看进程**
\`\`\`json
bash { "command": "ps aux | grep node" }
\`\`\`
</example>

<example>
**链式 Git 操作**（依赖命令必须顺序执行）
\`\`\`json
bash { "command": "git add . && git commit -m 'feat: add feature'" }
\`\`\`
</example>

<example>
**指定超时的长时间操作**
\`\`\`json
bash { "command": "npm run e2e", "timeout": 300000 }
\`\`\`
</example>

<example>
**在指定目录执行**
\`\`\`json
bash { "command": "npm install", "working_directory": "/path/to/project" }
\`\`\`
</example>

### 何时不使用

**绝对不要**使用 bash 执行以下操作：

| 操作 | 正确的工具 | 错误示例 |
|------|-----------|---------|
| 读取文件内容 | read_file | ❌ \`cat file.txt\` |
| 搜索文件 | glob | ❌ \`find . -name "*.ts"\` |
| 搜索文件内容 | grep | ❌ \`grep -r "pattern" .\` |
| 编辑文件 | edit_file | ❌ \`sed -i 's/old/new/g' file.txt\` |
| 创建文件 | write_file | ❌ \`echo "content" > file.txt\` |
| 列出目录 | list_directory | ❌ \`ls -la\` |

### 并行 vs 顺序执行

**并行执行**：独立操作可以同时发起多个 bash 调用
\`\`\`
// 可以并行
bash { "command": "npm run lint" }
bash { "command": "npm run test" }
\`\`\`

**顺序执行**：依赖操作必须用 && 链接
\`\`\`
// 必须顺序
bash { "command": "git add . && git commit -m 'msg' && git push" }
\`\`\`

### Git 安全规则

1. **永远不要**使用 \`--force\` 推送，除非用户明确要求
2. **永远不要**跳过 hooks（\`--no-verify\`），除非用户明确要求
3. **永远不要**在没有检查 status 的情况下 commit
4. 提交前始终运行 \`git status\` 和 \`git diff\`
5. 使用描述性的 commit 消息
6. 避免 \`git reset --hard\`，使用更安全的替代方案

### 路径引用

**必须**对包含空格的路径使用引号：
\`\`\`
// 正确
bash { "command": "cd \\"/path/with spaces\\"" }

// 错误 - 会失败
bash { "command": "cd /path/with spaces" }
\`\`\`

### 输出限制

- 输出超过 30000 字符会被截断
- 如果需要完整输出，考虑重定向到文件后用 read_file 读取

### 超时处理

- 默认超时 120 秒（2 分钟）
- 长时间操作（如构建、测试）可能需要更长超时
- 超时后命令会被终止，返回错误
`;
