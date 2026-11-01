import { describe, expect, it } from 'vitest';
import { buildCsvSheetsJson } from '../../../src/renderer/components/features/chat/ChatInput/csvSheets';

function parseSheets(json: string) {
  return JSON.parse(json).sheets[0];
}

describe('buildCsvSheetsJson', () => {
  it('首行作表头，其余作数据行，数字列保持数值类型', () => {
    const spec = parseSheets(buildCsvSheetsJson('sales.csv', '月份,销售额\n一月,1000\n二月,2000')!);
    expect(spec.headers).toEqual(['月份', '销售额']);
    expect(spec.rows).toEqual([['一月', 1000], ['二月', 2000]]);
    expect(spec.rowCount).toBe(2);
  });

  it('带引号逗号的字段按单列解析', () => {
    const spec = parseSheets(buildCsvSheetsJson('sales.csv', 'name,note\n"a,b",5')!);
    expect(spec.rows).toEqual([['a,b', 5]]);
  });

  it('数据行上限 500（与 extract-excel-json 同口径），rowCount 记完整行数', () => {
    const lines = ['h1,h2', ...Array.from({ length: 502 }, (_, i) => [`${i}`, `${i + 1}`].join(','))];
    const spec = parseSheets(buildCsvSheetsJson('big.csv', lines.join('\n'))!);
    expect(spec.rows).toHaveLength(500);
    expect(spec.rows[499]).toEqual([499, 500]);
    expect(spec.rowCount).toBe(502);
  });

  it('未闭合引号（MissingQuotes）静默回退：返回 undefined', () => {
    expect(buildCsvSheetsJson('bad.csv', 'name,age\n"unterminated,5\nx,y')).toBeUndefined();
  });

  it('空文件 / 全空白行返回 undefined', () => {
    expect(buildCsvSheetsJson('empty.csv', '')).toBeUndefined();
    expect(buildCsvSheetsJson('blank.csv', '\n\n\n')).toBeUndefined();
  });

  it('sheet 名取去扩展名的文件名；尾部空行裁掉、中间空行保留', () => {
    const parsed = JSON.parse(buildCsvSheetsJson('dir/sales.csv', 'a,b\n1,2\n\n3,4\n\n')!);
    expect(parsed.sheets[0].name).toBe('sales');
    expect(parsed.sheetCount).toBe(1);
    expect(parsed.sheets[0].rows).toEqual([[1, 2], [null], [3, 4]]);
    expect(parsed.sheets[0].rowCount).toBe(3); // 中间那条空行计入数据行
  });
});
