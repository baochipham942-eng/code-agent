// ============================================================================
// Excel Tool Description - ExcelAutomate 工具使用规范
// ============================================================================
// 描述 ExcelAutomate 三种模式：read / generate / automate
// ============================================================================

export const EXCEL_TOOL_DESCRIPTION = `
## ExcelAutomate 工具

操作 Excel 文件的专用工具，支持三种模式。

### 模式

| 模式 | 用途 | 说明 |
|------|------|------|
| read | 读取 xlsx | **必须先用 read 确认数据结构**再做任何操作 |
| generate | 生成新 xlsx | 用 openpyxl 生成新文件（支持多 sheet、样式、图表） |
| automate | 操作已打开的 Excel | 通过 xlwings 控制本地 Excel 应用（需 Excel 已打开） |

### 使用原则
- **读取优先**：任何处理前必须先 read，确认列名、数据类型、行数
- **禁止硬编码列名**：列名必须从 read 结果中获取，不要凭猜测写死
- **automate 前置条件**：目标文件必须在 Excel 中已打开
- **大数据量**：超过 10 万行优先用 bash + pandas 处理，再用 generate 输出
`;
