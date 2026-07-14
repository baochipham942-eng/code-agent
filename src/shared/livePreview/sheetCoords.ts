// 表格预览的 A1 换算——UI 点选与 DocEdit 写入之间唯一的坐标口径。
//
// 这段换算原本只活在 SpreadsheetBlock 里，验收脚本和单测各自手抄一份常量。
// 结果是「预览把坐标算错」这类 bug 谁也照不出来：脚本手工构造 B2，测试自己
// 重写一遍公式，两边都绕开了真正被用户点到的那段代码（2026-07-14 行错位 +
// 工作表错位）。凡是需要 A1 的地方都从这里取，不要再抄第二份。

/** 列索引 → A1 列字母（0→A, 25→Z, 26→AA） */
export function columnLetter(columnIndex: number): string {
  let n = columnIndex;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * 预览数据行下标 + 列下标 → A1 引用。
 *
 * dataRowIndex 是 extract-excel-json 返回的 `rows` 下标（不含表头）；xlsx 里表头
 * 占第 1 行，所以行号 = 下标 + 2。这要求 rows 保留中间空行——空行一旦被压缩，
 * 后面每一行的 A1 都会左移一位，而 DocEdit 会照着改，且不报错。
 */
export function sheetCellRef(dataRowIndex: number, columnIndex: number): string {
  return `${columnLetter(columnIndex)}${dataRowIndex + 2}`;
}
