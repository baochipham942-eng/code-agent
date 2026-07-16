// 表格预览的 A1 换算——UI 点选与 DocEdit 写入之间唯一的坐标口径。
//
// 这段换算原本只活在 SpreadsheetBlock 里，验收脚本和单测各自手抄一份常量。
// 结果是「预览把坐标算错」这类 bug 谁也照不出来：脚本手工构造 B2，测试自己
// 重写一遍公式，两边都绕开了真正被用户点到的那段代码（2026-07-14 行错位 +
// 工作表错位）。凡是需要 A1 的地方都从这里取，不要再抄第二份。

/** sheet_to_json 输出相对于工作表左上角的真实偏移，均为 0-based。 */
export interface SheetRangeStart {
  row: number;
  column: number;
}

export interface ResolvedSheetCoordinate {
  /** xlsx 真实行号，1-based。 */
  row: number;
  /** xlsx 真实列下标，0-based。 */
  column: number;
}

/**
 * sheet_to_json 局部下标 → xlsx 真实坐标。
 *
 * `rangeStart` 缺省即 A1，保证绝大多数工作簿继续走原来的逐字节输出；非 A1 表则把
 * decode_range(!ref).s 带进来。模型上下文行号与预览 A1 必须共用这里，不能各加一次。
 */
export function resolveSheetCoordinate(
  rowIndex: number,
  columnIndex: number,
  rangeStart?: SheetRangeStart,
): ResolvedSheetCoordinate {
  return {
    row: (rangeStart?.row ?? 0) + rowIndex + 1,
    column: (rangeStart?.column ?? 0) + columnIndex,
  };
}

/** 列索引 → A1 列字母（0→A, 25→Z, 26→AA）。模块私有：外部一律走 sheetCellRef，别再长出第二个换算入口。 */
function columnLetter(columnIndex: number): string {
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
 * dataRowIndex 是 extract-excel-json 返回的 `rows` 下标（不含 used range 的首行表头）；
 * rangeStart 缺省 A1 时行号仍是下标 + 2。rows 必须保留中间空行，且非 A1 起点必须
 * 随预览结果传入，否则后续 A1 会错位，而 DocEdit 会照着改且不报错。
 */
export function sheetCellRef(
  dataRowIndex: number,
  columnIndex: number,
  rangeStart?: SheetRangeStart,
): string {
  // rows 不含表头，因此局部行下标要先 +1，再统一交给真实坐标转换。
  const resolved = resolveSheetCoordinate(dataRowIndex + 1, columnIndex, rangeStart);
  return `${columnLetter(resolved.column)}${resolved.row}`;
}
