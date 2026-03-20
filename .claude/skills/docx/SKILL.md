---
name: docx
description: Word 文档 AI 助手 — 读取、编辑、生成、审阅 DOCX 文件
keywords: [docx, word, doc, document, 文档, 合同, 法务, 审阅]
allowed-tools: [Bash, Read, Glob, Grep, DocEdit, docx_generate]
execution-context: inline
---

# Word 文档 AI 助手

你正在执行 Word 文档（DOCX）处理任务。严格按以下流程操作。

## 第 1 步：确认文件

根据用户输入决定工作模式：

- **提供了文件路径** → 进入「读取 + 编辑」流程
- **未提供文件但要求生成** → 进入「生成」流程

如果路径不确定，用 Glob 搜索：
```
*.docx 或 **/*.docx
```

## 第 2 步：读取文档（编辑前必做）

对已有文件，**必须先读取**，获取：
- 段落数量和结构
- 标题层级（Heading1/2/3）
- 文本内容概要
- 是否包含表格、图片、超链接

将读取结果展示给用户，确认理解一致后再操作。

## 第 3 步：执行处理

### 方式 A：DocEdit（增量编辑，推荐）
适用于：替换文本、修改段落、调整样式、插入/删除段落

可用操作：
- `replace_text`: 替换文本（支持全局替换）
- `replace_paragraph`: 替换指定段落
- `insert_paragraph`: 在指定位置后插入
- `delete_paragraph`: 删除段落
- `replace_heading`: 替换标题文本
- `append_paragraph`: 末尾追加段落
- `set_text_style`: 设置文字样式（粗体/斜体/颜色）
- `track_insert`: 插入文本并标记为修订（Track Changes）
- `track_delete`: 标记文本为删除修订
- `suggest_replace`: 建议替换（删除旧文本 + 插入新文本，均为修订标记）

### 方式 B：docx_generate（全新生成）
适用于：从零创建文档

### 方式 C：Python python-docx（复杂排版）
适用于：需要精细控制的复杂文档（合同模板、多级列表、页眉页脚）

## 第 4 步：验证输出

编辑/生成后必须验证：
1. 重新读取文档确认结构正确
2. 检查段落数量是否符合预期
3. 检查关键文本是否完整

## 规则

1. **读取优先，禁止盲操作**：任何编辑前必须先读取确认文档结构
2. **增量优于重建**：能用 DocEdit 解决的不要重新生成整个文档
3. **保留原文件**：编辑结果写入原文件（有自动快照），生成结果写入新文件
4. **修订审阅场景**：合同审阅、法务修订等协作场景使用 Track Changes 操作
5. **XML 参考**：编辑 OOXML 时参考 `references/ooxml-patterns.md`

## 示例

- `/docx contract.docx 将甲方名称改为 XX科技有限公司`
- `/docx report.docx 在第3段后插入新的分析结论`
- `/docx 生成一份项目周报`
- `/docx agreement.docx 用修订模式标记需要修改的条款`

$ARGUMENTS
