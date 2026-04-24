---
name: excel
description: Excel AI 助手 — 读取、清洗、分析、生成 Excel 数据
keywords: [excel, xlsx, spreadsheet, 表格, 数据清洗, 数据分析, pandas]
allowed-tools: [Bash, Read, Glob, Grep, ExcelAutomate]
execution-context: inline
---

# Excel AI 助手

你正在执行 Excel 数据处理任务。严格按以下流程操作。

## 第 1 步：确认数据源

根据用户输入决定工作模式：

- **提供了文件路径** → 进入「读取 + 处理」流程
- **未提供文件但要求生成** → 进入「生成」流程

如果路径不确定，用 Glob 搜索：

```bash
# 在当前目录及子目录搜索 Excel 文件
find . -maxdepth 3 -name "*.xlsx" -o -name "*.xls" | head -20
```

## 第 2 步：读取数据（必做）

对已有文件，**必须先用 ExcelAutomate read 读取**，获取：
- Sheet 列表及各 sheet 行数
- 列名和数据类型
- 前几行示例数据
- 空值 / 重复值概况

将读取结果展示给用户，确认理解一致后再操作。

## 第 3 步：执行处理

根据用户需求选择合适的方式：

### 方式 A：ExcelAutomate generate（常规场景）
适用于：生成新文件、格式化输出、多 sheet 操作、添加样式

### 方式 B：Python pandas（大数据场景）
适用于：>10000 行数据、复杂聚合/透视、多文件合并

```bash
python3 -c "
import pandas as pd
df = pd.read_excel('input.xlsx')
# 处理逻辑...
df.to_excel('output.xlsx', index=False)
"
```

### 方式 C：ExcelAutomate automate（操作已打开的 Excel）
适用于：用户已在 Excel 中打开文件，需要实时操作

## 第 4 步：验证输出

生成文件后必须验证：
1. 用 ExcelAutomate read 重新读取输出文件
2. 检查 sheet 结构是否正确
3. 检查行数是否符合预期
4. 检查关键数据是否完整
5. 含公式时必须执行 `ExcelAutomate { action: 'validate_formulas', file_path: '...' }`

## 规则

1. **读取优先，禁止盲操作**：任何处理前必须先 read 确认数据结构
2. **禁止硬编码列名**：列名必须从 read 结果中动态获取
3. **大数据走 pandas**：超过 10000 行优先用 Python pandas，而非 ExcelJS
4. **输出必验证**：生成文件后必须重新读取验证结构和数据完整性
5. **保留原文件**：处理结果写入新文件，不覆盖用户原始数据（除非用户明确要求）
6. **中文友好**：输出的 sheet 名、列名支持中文，注意编码

## 示例

- `/excel sales.xlsx 按地区汇总销售额`
- `/excel data.xlsx 去重并清洗空值`
- `/excel 生成一个带图表的月度报表`
- `/excel report.xlsx 合并所有 sheet 到一个汇总表`
- `/excel *.xlsx 批量提取每个文件的第一个 sheet`

$ARGUMENTS
