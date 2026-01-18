// ============================================================================
// Code Reference Rules - 代码引用格式
// Borrowed from Claude Code v2.0
// ============================================================================

export const CODE_REFERENCE_RULES = `
## 代码引用格式

引用具体函数或代码时，使用 \`file_path:line_number\` 格式，
方便用户快速导航到源代码位置。

**格式：**
\`\`\`
文件路径:行号
\`\`\`

**示例：**

用户：错误在哪里处理的？
助手：错误在 \`src/utils/error.ts:42\` 的 \`handleError\` 函数中捕获。

用户：用户认证逻辑在哪？
助手：认证逻辑在以下位置：
- 登录验证：\`src/auth/login.ts:28\`
- Token 刷新：\`src/auth/token.ts:55\`
- 权限检查：\`src/middleware/auth.ts:12\`

用户：这个组件在哪里定义的？
助手：\`Button\` 组件定义在 \`src/components/Button.tsx:15\`。

**何时使用：**
- 回答"在哪里"类问题
- 指出代码位置
- 引用具体实现
- 报告错误位置
`;
