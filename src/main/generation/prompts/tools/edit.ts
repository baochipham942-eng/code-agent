// ============================================================================
// Edit Tool Description - Detailed usage guide for the edit_file tool
// ============================================================================

/**
 * 详细的 Edit 工具描述
 *
 * 包含参数说明、使用示例、错误处理等
 * 约 1000 tokens
 */
export const EDIT_TOOL_DESCRIPTION = `
## Edit 工具详细指南

对文件执行精确的字符串替换。这是修改文件内容的主要方式。

### 核心规则

**必须先读取文件**：在调用 edit_file 之前，必须先使用 read_file 读取目标文件。
违反此规则将导致编辑失败。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file_path | string | 是 | 文件的绝对路径 |
| old_string | string | 是 | 要替换的原始文本（必须精确匹配） |
| new_string | string | 是 | 替换后的新文本 |
| replace_all | boolean | 否 | 是否替换所有匹配项，默认 false |

### 使用示例

<example>
**修改函数实现**
\`\`\`json
edit_file {
  "file_path": "/project/src/utils.ts",
  "old_string": "function add(a, b) {\\n  return a + b;\\n}",
  "new_string": "function add(a: number, b: number): number {\\n  return a + b;\\n}"
}
\`\`\`
</example>

<example>
**修复 typo**
\`\`\`json
edit_file {
  "file_path": "/project/README.md",
  "old_string": "This is a exmaple",
  "new_string": "This is an example"
}
\`\`\`
</example>

<example>
**重命名变量（全文替换）**
\`\`\`json
edit_file {
  "file_path": "/project/src/app.ts",
  "old_string": "oldVarName",
  "new_string": "newVarName",
  "replace_all": true
}
\`\`\`
</example>

<example>
**删除代码块**（使用空字符串）
\`\`\`json
edit_file {
  "file_path": "/project/src/temp.ts",
  "old_string": "// TODO: remove this\\nconsole.log('debug');\\n",
  "new_string": ""
}
\`\`\`
</example>

<example>
**添加导入语句**
\`\`\`json
edit_file {
  "file_path": "/project/src/index.ts",
  "old_string": "import { foo } from './foo';",
  "new_string": "import { foo } from './foo';\\nimport { bar } from './bar';"
}
\`\`\`
</example>

### 常见错误及解决方案

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| "text not found" | old_string 不匹配 | 检查空白字符、缩进、换行 |
| "multiple occurrences" | 匹配到多处 | 增加上下文使其唯一，或用 replace_all |
| "no changes made" | old_string == new_string | 确保新旧内容不同 |
| "file not found" | 路径错误 | 使用绝对路径，检查文件是否存在 |

### 精确匹配要点

1. **保持缩进一致**
   - 如果原文用 2 空格缩进，替换文本也要用 2 空格
   - 如果原文用 Tab，替换文本也要用 Tab

2. **换行符**
   - 使用 \`\\n\` 表示换行
   - 多行文本中的每个换行都要包含

3. **行号前缀**
   - read_file 输出的行号前缀（如 "  12→"）不是文件内容的一部分
   - 复制文本时忽略这些前缀

4. **唯一性保证**
   - 默认模式下，old_string 必须在文件中唯一
   - 包含 2-3 行上下文可以确保唯一性

### 何时不使用

| 场景 | 正确的工具 |
|------|-----------|
| 创建新文件 | write_file |
| 完全重写文件 | write_file |
| 读取文件内容 | read_file |
| 文件不存在 | write_file |

### 最佳实践

1. **先读后写**：总是先 read_file 了解当前内容
2. **小步修改**：多次小修改比一次大修改更安全
3. **验证结果**：编辑后可以再次 read_file 验证
4. **保守匹配**：用更多上下文而非依赖 replace_all
5. **注意空白**：空格、Tab、换行都很重要
`;
