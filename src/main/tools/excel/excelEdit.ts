// ============================================================================
// Excel Edit - Atomic cell/row/column level editing for existing Excel files
// ============================================================================
// Enables incremental edits instead of full-file regeneration.
// Token savings: ~80% compared to regenerating the entire file.
// ============================================================================

import * as fs from 'fs';
import ExcelJS from 'exceljs';
import type { ToolContext, ToolExecutionResult } from '../types';
import { createSnapshot, restoreLatest } from '../document/snapshotManager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontColor?: string;    // hex without #, e.g. "FF0000"
  fill?: string;         // hex without #
  numberFormat?: string; // e.g. "#,##0.00", "0%"
  alignment?: 'left' | 'center' | 'right';
  border?: boolean;
}

type ExcelEditOperation =
  | { action: 'set_cell';       sheet?: string; cell: string; value: string | number | boolean; format?: CellStyle }
  | { action: 'set_range';      sheet?: string; range: string; values: (string | number | boolean | null)[][] }
  | { action: 'set_formula';    sheet?: string; cell: string; formula: string }
  | { action: 'insert_rows';    sheet?: string; after: number; count?: number; data?: (string | number | boolean | null)[][] }
  | { action: 'delete_rows';    sheet?: string; from: number; count?: number }
  | { action: 'insert_columns'; sheet?: string; after: string; count?: number; headers?: string[] }
  | { action: 'delete_columns'; sheet?: string; from: string; count?: number }
  | { action: 'set_style';      sheet?: string; range: string; style: CellStyle }
  | { action: 'rename_sheet';   sheet: string; newName: string }
  | { action: 'add_sheet';      name: string; after?: string }
  | { action: 'delete_sheet';   sheet: string }
  | { action: 'set_column_width'; sheet?: string; column: string; width: number }
  | { action: 'merge_cells';    sheet?: string; range: string }
  | { action: 'auto_filter';    sheet?: string; range: string };

export interface ExcelEditParams {
  file_path: string;
  operations: ExcelEditOperation[];
  dry_run?: boolean;
}

// ---------------------------------------------------------------------------
// Style applicator
// ---------------------------------------------------------------------------

function applyStyle(cell: ExcelJS.Cell, style: CellStyle): void {
  if (style.bold !== undefined || style.italic !== undefined || style.fontSize || style.fontColor) {
    const existing = cell.font || {};
    cell.font = {
      ...existing,
      ...(style.bold !== undefined && { bold: style.bold }),
      ...(style.italic !== undefined && { italic: style.italic }),
      ...(style.fontSize && { size: style.fontSize }),
      ...(style.fontColor && { color: { argb: style.fontColor } }),
    };
  }

  if (style.fill) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: style.fill },
    };
  }

  if (style.numberFormat) {
    cell.numFmt = style.numberFormat;
  }

  if (style.alignment) {
    cell.alignment = { horizontal: style.alignment };
  }

  if (style.border) {
    const thin: ExcelJS.Border = { style: 'thin', color: { argb: 'D0D0D0' } };
    cell.border = { top: thin, bottom: thin, left: thin, right: thin };
  }
}

// ---------------------------------------------------------------------------
// Column letter ↔ number helpers
// ---------------------------------------------------------------------------

function columnLetterToNumber(letter: string): number {
  let result = 0;
  for (let i = 0; i < letter.length; i++) {
    result = result * 26 + (letter.charCodeAt(i) - 64);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Get worksheet by name or default to first
// ---------------------------------------------------------------------------

function getWorksheet(workbook: ExcelJS.Workbook, sheetName?: string): ExcelJS.Worksheet {
  if (sheetName) {
    const ws = workbook.getWorksheet(sheetName);
    if (!ws) throw new Error(`Sheet "${sheetName}" not found`);
    return ws;
  }
  const ws = workbook.worksheets[0];
  if (!ws) throw new Error('Workbook has no worksheets');
  return ws;
}

// ---------------------------------------------------------------------------
// Execute a single operation
// ---------------------------------------------------------------------------

function executeOperation(workbook: ExcelJS.Workbook, op: ExcelEditOperation): string {
  switch (op.action) {
    case 'set_cell': {
      const ws = getWorksheet(workbook, op.sheet);
      const cell = ws.getCell(op.cell);
      cell.value = op.value as ExcelJS.CellValue;
      if (op.format) applyStyle(cell, op.format);
      return `Set ${op.cell}=${JSON.stringify(op.value)}`;
    }

    case 'set_range': {
      const ws = getWorksheet(workbook, op.sheet);
      // Parse range like "A1:C3"
      const [startRef] = op.range.split(':');
      const startCell = ws.getCell(startRef);
      const { row: startRow, col: startCol } = startCell.fullAddress;

      let cellCount = 0;
      for (let r = 0; r < op.values.length; r++) {
        for (let c = 0; c < op.values[r].length; c++) {
          const val = op.values[r][c];
          if (val !== null && val !== undefined) {
            ws.getCell(startRow + r, startCol + c).value = val as ExcelJS.CellValue;
            cellCount++;
          }
        }
      }
      return `Set ${cellCount} cells in range ${op.range}`;
    }

    case 'set_formula': {
      const ws = getWorksheet(workbook, op.sheet);
      const cell = ws.getCell(op.cell);
      cell.value = { formula: op.formula } as ExcelJS.CellFormulaValue;
      return `Set formula ${op.cell}=${op.formula}`;
    }

    case 'insert_rows': {
      const ws = getWorksheet(workbook, op.sheet);
      const count = op.count || (op.data ? op.data.length : 1);
      // splice inserts rows at position, shifting existing rows down
      ws.spliceRows(op.after + 1, 0, ...Array.from({ length: count }, (_, i) => {
        return op.data?.[i] || [];
      }));
      return `Inserted ${count} row(s) after row ${op.after}`;
    }

    case 'delete_rows': {
      const ws = getWorksheet(workbook, op.sheet);
      const count = op.count || 1;
      ws.spliceRows(op.from, count);
      return `Deleted ${count} row(s) starting at row ${op.from}`;
    }

    case 'insert_columns': {
      const ws = getWorksheet(workbook, op.sheet);
      const colNum = columnLetterToNumber(op.after.toUpperCase());
      const count = op.count || 1;
      ws.spliceColumns(colNum + 1, 0, ...Array.from({ length: count }, (_, i) => {
        return op.headers ? [op.headers[i] || ''] : [''];
      }));
      return `Inserted ${count} column(s) after column ${op.after}`;
    }

    case 'delete_columns': {
      const ws = getWorksheet(workbook, op.sheet);
      const colNum = columnLetterToNumber(op.from.toUpperCase());
      const count = op.count || 1;
      ws.spliceColumns(colNum, count);
      return `Deleted ${count} column(s) starting at column ${op.from}`;
    }

    case 'set_style': {
      const ws = getWorksheet(workbook, op.sheet);
      // Parse range "A1:C3" or single cell "A1"
      const parts = op.range.split(':');
      if (parts.length === 2) {
        const start = ws.getCell(parts[0]).fullAddress;
        const end = ws.getCell(parts[1]).fullAddress;
        for (let r = Number(start.row); r <= Number(end.row); r++) {
          for (let c = Number(start.col); c <= Number(end.col); c++) {
            applyStyle(ws.getCell(r, c), op.style);
          }
        }
      } else {
        applyStyle(ws.getCell(parts[0]), op.style);
      }
      return `Applied style to ${op.range}`;
    }

    case 'rename_sheet': {
      const ws = getWorksheet(workbook, op.sheet);
      ws.name = op.newName;
      return `Renamed sheet "${op.sheet}" → "${op.newName}"`;
    }

    case 'add_sheet': {
      workbook.addWorksheet(op.name);
      return `Added sheet "${op.name}"`;
    }

    case 'delete_sheet': {
      const ws = getWorksheet(workbook, op.sheet);
      workbook.removeWorksheet(ws.id);
      return `Deleted sheet "${op.sheet}"`;
    }

    case 'set_column_width': {
      const ws = getWorksheet(workbook, op.sheet);
      const colNum = columnLetterToNumber(op.column.toUpperCase());
      ws.getColumn(colNum).width = op.width;
      return `Set column ${op.column} width=${op.width}`;
    }

    case 'merge_cells': {
      const ws = getWorksheet(workbook, op.sheet);
      ws.mergeCells(op.range);
      return `Merged cells ${op.range}`;
    }

    case 'auto_filter': {
      const ws = getWorksheet(workbook, op.sheet);
      ws.autoFilter = op.range;
      return `Set auto filter on ${op.range}`;
    }

    default:
      throw new Error(`Unknown edit action: ${(op as ExcelEditOperation).action}`);
  }
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function executeExcelEdit(
  params: ExcelEditParams,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const { file_path, operations, dry_run } = params;

  // Validate file exists
  if (!fs.existsSync(file_path)) {
    return { success: false, error: `File not found: ${file_path}` };
  }

  if (!operations || operations.length === 0) {
    return { success: false, error: 'No operations provided' };
  }

  // Dry run: validate operations without modifying the file
  if (dry_run) {
    const preview = operations.map((op, i) => `${i + 1}. [${op.action}] ${JSON.stringify(op)}`);
    return {
      success: true,
      output: `Dry run — ${operations.length} operation(s) would be applied:\n${preview.join('\n')}`,
    };
  }

  // Create backup snapshot before editing
  const snapshot = createSnapshot(file_path, `excel-edit: ${operations.length} ops`);

  try {
    // Load workbook
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file_path);

    // Execute operations sequentially
    const results: string[] = [];
    for (const op of operations) {
      const result = executeOperation(workbook, op);
      results.push(result);
    }

    // Save
    await workbook.xlsx.writeFile(file_path);

    const stats = fs.statSync(file_path);

    return {
      success: true,
      output: `Excel edited successfully (${operations.length} operations):\n${results.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}\n\nFile: ${file_path} (${(stats.size / 1024).toFixed(1)} KB)\nSnapshot: ${snapshot.id}`,
      outputPath: file_path,
      metadata: {
        filePath: file_path,
        snapshotId: snapshot.id,
        snapshotPath: snapshot.snapshotPath,
        operationCount: operations.length,
        operations: results,
      },
    };
  } catch (error: unknown) {
    // Restore from snapshot on failure
    restoreLatest(file_path);

    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Excel edit failed (auto-restored from snapshot ${snapshot.id}): ${message}`,
      metadata: { snapshotId: snapshot.id },
    };
  }
}
