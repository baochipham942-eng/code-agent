// ============================================================================
// csvSheets - .csv 文本 → SpreadsheetBlock 的 sheetsJson（与 xlsx 附件同款交互预览）
// ----------------------------------------------------------------------------
// 形状对齐 host 侧 extract-excel-json（settings.ipc.ts）：首行是表头、数据行
// 上限 500、rowCount 记完整数据行数。category 保持 data，模型侧 converter 不变。
// 注意：本模块 import papaparse，消费方必须动态 import，别把它拉进主 bundle
// （同 CsvTable 的懒加载拆包策略）。
// ============================================================================

import Papa from 'papaparse';

/** UI 渲染行数上限，与 extract-excel-json 的 `slice(1, 501)` 同口径 */
const MAX_SHEET_ROWS = 500;

function isBlankRow(row: unknown[]): boolean {
  return row.length === 0 || row.every((cell) => cell === null || cell === undefined || cell === '');
}

/**
 * 解析失败 → undefined（静默回退为今天的普通图标卡）。
 * 判据：一行数据都没有（空文件 / 全空白行），或引号未闭合（MissingQuotes，
 * 行结构已不可信）。UndetectableDelimiter 是 informational（小文件常见，
 * papaparse 默认回退 ','），不算失败。
 */
function hasUnrecoverableErrors(errors: Papa.ParseError[]): boolean {
  return errors.some((error) => error.code === 'MissingQuotes');
}

export function buildCsvSheetsJson(fileName: string, text: string): string | undefined {
  const parsed = Papa.parse<unknown[]>(text, {
    header: false,
    dynamicTyping: true,
  });

  if (parsed.data.length === 0 || hasUnrecoverableErrors(parsed.errors)) return undefined;

  // 尾部空行裁掉、中间空行保留（与 extract-excel-json 的 sheetRowsWithRealNumbers 同口径）
  let end = parsed.data.length;
  while (end > 0 && isBlankRow(parsed.data[end - 1])) end--;
  const trimmed = parsed.data.slice(0, end);
  if (trimmed.length === 0) return undefined;

  const headers = (trimmed[0] || []).map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
  const rows = trimmed.slice(1, MAX_SHEET_ROWS + 1);
  const name = (fileName.split('/').pop() || fileName).replace(/\.csv$/i, '') || 'csv';

  return JSON.stringify({
    sheets: [{ name, headers, rows, rowCount: Math.max(trimmed.length - 1, 0) }],
    sheetCount: 1,
  });
}
