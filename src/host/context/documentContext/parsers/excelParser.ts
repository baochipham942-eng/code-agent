// ============================================================================
// Excel Parser - Excel 表格（复用 exceljs）
// ============================================================================

import type { DocumentParser, DocumentSection, ParsedDocument } from '../types';
import { ParsedDocumentImpl, estimateTokenCount } from '../parsedDocumentImpl';

const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);

export class ExcelParser implements DocumentParser {
  canParse(filePath: string): boolean {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    return EXCEL_EXTENSIONS.has(ext.toLowerCase());
  }

  async parse(content: string | Buffer, filePath: string): Promise<ParsedDocument> {
    const sections: DocumentSection[] = [];

    if (filePath.endsWith('.csv')) {
      // CSV: 简单按行分割
      const text = typeof content === 'string' ? content : content.toString('utf-8');
      const lines = text.split('\n');
      const header = lines[0] || '';
      const dataLines = lines.slice(1).filter(l => l.trim().length > 0);

      sections.push({
        id: 'sec_header',
        title: 'Header',
        content: header,
        type: 'table',
        importance: 0.9,
        tokenEstimate: estimateTokenCount(header),
        startLine: 1,
        endLine: 1,
      });

      // 数据按块分组（每 50 行一组）
      const chunkSize = 50;
      for (let i = 0; i < dataLines.length; i += chunkSize) {
        const chunk = dataLines.slice(i, i + chunkSize);
        const chunkContent = chunk.join('\n');
        sections.push({
          id: `sec_data_${i}`,
          title: `Rows ${i + 2}-${Math.min(i + chunkSize + 1, dataLines.length + 1)}`,
          content: chunkContent,
          type: 'table',
          importance: i === 0 ? 0.7 : 0.4, // 前几行更重要
          tokenEstimate: estimateTokenCount(chunkContent),
          startLine: i + 2,
          endLine: Math.min(i + chunkSize + 1, dataLines.length + 1),
        });
      }
    } else {
      // XLSX: 尝试使用 exceljs（如果可用）
      try {
        const ExcelJS = await import('exceljs');
        const workbook = new ExcelJS.default.Workbook();

        if (Buffer.isBuffer(content)) {
          await workbook.xlsx.load(Buffer.from(content) as never);
        } else {
          // content 是文件路径或文本，尝试作为文件路径
          await workbook.xlsx.readFile(filePath);
        }

        workbook.eachSheet((worksheet, sheetId) => {
          const rows: string[] = [];
          worksheet.eachRow((row, rowNumber) => {
            const values = (row.values as unknown[])?.slice(1) || []; // exceljs row.values[0] 是空的
            rows.push(values.map(v => String(v ?? '')).join('\t'));
          });

          const sheetContent = rows.join('\n');
          sections.push({
            id: `sec_sheet_${sheetId}`,
            title: `Sheet: ${worksheet.name}`,
            content: sheetContent,
            type: 'table',
            importance: sheetId === 1 ? 0.8 : 0.5, // 第一个 sheet 更重要
            tokenEstimate: estimateTokenCount(sheetContent),
          });
        });
      } catch {
        // exceljs 不可用，返回原始内容提示
        const text = typeof content === 'string' ? content : '[Binary Excel file - exceljs not available]';
        sections.push({
          id: 'sec_fallback',
          title: 'Excel Content',
          content: text,
          type: 'table',
          importance: 0.5,
          tokenEstimate: estimateTokenCount(text),
        });
      }
    }

    return new ParsedDocumentImpl('excel', filePath, sections);
  }
}
