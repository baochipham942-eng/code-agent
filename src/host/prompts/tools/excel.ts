// ============================================================================
// Excel Tool Description - ExcelAutomate 工具使用规范
// ============================================================================
// 描述 ExcelAutomate 当前 action：read / generate / edit / automate 等
// ============================================================================

import { applyOverride } from '../registry';

export const EXCEL_TOOL_DESCRIPTION = applyOverride(
  { id: 'tools.excel', category: '工具描述', name: 'Excel 工具描述', description: 'Excel tool 的 prompt 描述' },
  `
## ExcelAutomate 工具

操作 Excel 文件的专用工具。读取 .xlsx/.xls 时必须用 ExcelAutomate，不要用普通 Read。

### Actions

| Action | 用途 | 说明 |
|------|------|------|
| read | 读取 xlsx/xls | **必须先用 read 确认数据结构**再做任何操作 |
| generate | 生成新 xlsx | 用 openpyxl 生成新文件（支持多 sheet、样式、图表） |
| edit | 原子修改现有 xlsx | 修改单元格、范围、公式、行列、样式、sheet，自动备份 |
| automate | 操作已打开的 Excel | 通过 xlwings 控制本地 Excel 应用 |
| list_sheets | 列出 sheet | 快速确认 workbook 结构 |
| get_range | 读取指定范围 | 读取打开 workbook 的指定 cell range |
| validate_formulas | 校验公式 | 扫描 #REF!、#DIV/0! 等公式错误 |

### 使用原则
- **读取优先**：任何处理前必须先 read，确认列名、数据类型、行数
- **禁止硬编码列名**：列名必须从 read 结果中获取，不要凭猜测写死
- **小改用 edit**：已有文件的单元格/公式/样式修改优先 edit，不要整表重生成
- **automate 前置条件**：需要控制本地 Excel app 时才用 automate
- **大数据量**：超过 10 万行优先用 bash + pandas 处理，再用 generate 输出
`,
);
