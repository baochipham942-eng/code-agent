// ============================================================================
// Edit Tool Description - Detailed usage guide for the Edit tool
// ============================================================================

/**
 * Edit 工具描述（精简版）
 * 约 200 tokens
 */
import { applyOverride } from '../registry';

export const EDIT_TOOL_DESCRIPTION = applyOverride(
  { id: 'tools.edit', category: '工具描述', name: 'Edit 工具描述', description: 'Edit tool 的 prompt 描述' },
  `
## Edit 工具

对同一个文件执行一组精确文本替换。**必须先 Read 才能 Edit**。

### 参数
- \`file_path\`: 绝对路径（必填）
- \`edits\`: 编辑数组（必填），按顺序执行
  - \`old_text\`: 要替换的原文（必填，必须精确匹配）
  - \`new_text\`: 替换后的文本（必填）
  - \`replace_all\`: 替换所有匹配项（可选，默认 false）
- \`force\`: 绕过安全检查（可选，默认 false）

### 常见错误
| 错误 | 解决 |
|-----|-----|
| text not found | 检查缩进、换行、空格 |
| multiple occurrences | 增加上下文或在对应 edit 中设置 replace_all |

### 要点
- 保持原文缩进（空格/Tab）
- 用 \`\\n\` 表示换行
- Read 的行号前缀不是文件内容
- 多处修改放在同一次 Edit 的 \`edits\` 数组里；任一 edit 失败会整体回滚
`,
);
