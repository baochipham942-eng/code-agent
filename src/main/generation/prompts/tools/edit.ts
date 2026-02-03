// ============================================================================
// Edit Tool Description - Detailed usage guide for the edit_file tool
// ============================================================================

/**
 * Edit 工具描述（精简版）
 * 约 200 tokens
 */
export const EDIT_TOOL_DESCRIPTION = `
## Edit 工具

精确字符串替换。**必须先 read_file 才能 edit_file**。

### 参数
- \`file_path\`: 绝对路径（必填）
- \`old_string\`: 要替换的文本（必填，必须精确匹配）
- \`new_string\`: 替换后的文本（必填）
- \`replace_all\`: 全部替换（可选，默认 false）

### 常见错误
| 错误 | 解决 |
|-----|-----|
| text not found | 检查缩进、换行、空格 |
| multiple occurrences | 增加上下文或用 replace_all |

### 要点
- 保持原文缩进（空格/Tab）
- 用 \`\\n\` 表示换行
- read_file 的行号前缀不是文件内容
`;
