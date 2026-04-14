// ============================================================================
// PPT 数据源适配器 - 加载 xlsx/csv 数据用于演示文稿
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { NUMERIC_COLUMN_THRESHOLD, CHART_MAX_ITEMS, CHART_LABEL_MAX_LENGTH } from './constants';

/**
 * Data source loading result
 */
export interface DataSourceResult {
  columns: string[];
  rows: string[][];
  metadata: {
    fileName: string;
    sheetName?: string;
    rowCount: number;
    columnCount: number;
  };
  insights: DataInsight[];
}

/**
 * Auto-detected data insight
 */
export interface DataInsight {
  type: 'summary' | 'top_values' | 'trend' | 'distribution';
  title: string;
  description: string;
  data?: { labels: string[]; values: number[] };
}

/**
 * Load data from xlsx or csv file
 *
 * @param filePath - Path to .xlsx or .csv file
 * @param sheetName - Optional sheet name for xlsx (defaults to first sheet)
 * @returns Parsed data with auto-detected insights
 */
export async function loadDataSource(
  filePath: string,
  sheetName?: string,
): Promise<DataSourceResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Data source not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    return loadExcelData(filePath, sheetName);
  } else if (ext === '.csv') {
    return loadCsvData(filePath);
  } else {
    throw new Error(`Unsupported data format: ${ext}. Use .xlsx or .csv`);
  }
}

async function loadExcelData(filePath: string, sheetName?: string): Promise<DataSourceResult> {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0];

  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName || 'first sheet'}`);
  }

  const columns: string[] = [];
  const rows: string[][] = [];

  // Extract headers from first row
  const headerRow = sheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell: any, colNumber: number) => {
    columns.push(String(cell.value || `Column ${colNumber}`));
  });

  // Extract data rows
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const rowData: string[] = [];
    let hasData = false;

    for (let c = 1; c <= columns.length; c++) {
      const cell = row.getCell(c);
      const value = cell.value;
      rowData.push(value != null ? String(value) : '');
      if (value != null && String(value).trim() !== '') hasData = true;
    }

    if (hasData) rows.push(rowData);
  }

  const insights = detectInsights(columns, rows);

  return {
    columns,
    rows,
    metadata: {
      fileName: path.basename(filePath),
      sheetName: sheet.name,
      rowCount: rows.length,
      columnCount: columns.length,
    },
    insights,
  };
}

async function loadCsvData(filePath: string): Promise<DataSourceResult> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  // Parse with simple CSV splitting (handles basic cases)
  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const columns = parseLine(lines[0]);
  const rows = lines.slice(1).map(l => parseLine(l));
  const insights = detectInsights(columns, rows);

  return {
    columns,
    rows,
    metadata: {
      fileName: path.basename(filePath),
      rowCount: rows.length,
      columnCount: columns.length,
    },
    insights,
  };
}

/**
 * Auto-detect insights from data
 */
function detectInsights(columns: string[], rows: string[][]): DataInsight[] {
  const insights: DataInsight[] = [];

  // Find numeric columns
  const numericCols: number[] = [];
  for (let c = 0; c < columns.length; c++) {
    const numCount = rows.filter(r => r[c] && !isNaN(parseFloat(r[c]))).length;
    if (numCount > rows.length * NUMERIC_COLUMN_THRESHOLD) {
      numericCols.push(c);
    }
  }

  // Summary insight: row/column counts
  insights.push({
    type: 'summary',
    title: '数据概览',
    description: `${rows.length} 行 × ${columns.length} 列`,
  });

  // Top values insight for first numeric column
  if (numericCols.length > 0 && rows.length >= 3) {
    const colIdx = numericCols[0];
    const colName = columns[colIdx];

    // Find a label column (first non-numeric)
    const labelCol = columns.findIndex((_, i) => !numericCols.includes(i));

    const sorted = [...rows]
      .filter(r => r[colIdx] && !isNaN(parseFloat(r[colIdx])))
      .sort((a, b) => parseFloat(b[colIdx]) - parseFloat(a[colIdx]))
      .slice(0, CHART_MAX_ITEMS);

    if (sorted.length >= 3) {
      insights.push({
        type: 'top_values',
        title: `${colName} Top ${sorted.length}`,
        description: `按 ${colName} 排序的前 ${sorted.length} 项`,
        data: {
          labels: sorted.map(r => labelCol >= 0 ? r[labelCol] : r[0]).map(l => l.slice(0, CHART_LABEL_MAX_LENGTH)),
          values: sorted.map(r => parseFloat(r[colIdx])),
        },
      });
    }

    // Distribution: compute basic stats
    const allValues = rows
      .map(r => parseFloat(r[colIdx]))
      .filter(v => !isNaN(v));

    if (allValues.length >= 3) {
      const sum = allValues.reduce((a, b) => a + b, 0);
      const avg = sum / allValues.length;
      const min = Math.min(...allValues);
      const max = Math.max(...allValues);

      insights.push({
        type: 'distribution',
        title: `${colName} 分布`,
        description: `均值: ${avg.toFixed(1)}, 范围: ${min.toFixed(1)} ~ ${max.toFixed(1)}`,
        data: {
          labels: ['最小值', '均值', '最大值'],
          values: [min, avg, max],
        },
      });
    }
  }

  return insights;
}
