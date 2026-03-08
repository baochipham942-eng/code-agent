// ============================================================================
// Read Document Tool - Consolidates readPdf + readDocx + readXlsx into 1
// Phase 2: Tool Schema Consolidation (Group 7: 3->1)
// Auto-detects format from file extension, no action param needed.
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { readPdfTool } from './readPdf';
import { readDocxTool } from './readDocx';
import { readXlsxTool } from './readXlsx';

// Supported extensions mapped to their handler
const EXTENSION_MAP: Record<string, 'pdf' | 'docx' | 'xlsx'> = {
  '.pdf': 'pdf',
  '.doc': 'docx',
  '.docx': 'docx',
  '.xls': 'xlsx',
  '.xlsx': 'xlsx',
};

export const ReadDocumentTool: Tool = {
  name: 'ReadDocument',
  description: `Read document files (PDF, Word, Excel) with automatic format detection from file extension.

Supported formats:
- .pdf: Uses vision model (Gemini 2.0) for AI-powered PDF analysis
- .docx / .doc: Reads Word documents with text/markdown/html output
- .xlsx / .xls: Reads Excel spreadsheets with table/json/csv output and data quality analysis

The format is auto-detected from the file extension. No action parameter needed.

Parameters:
- file_path (required): Path to the document file
- prompt (optional, PDF only): Specific question or instruction for analyzing the PDF
- format (optional): Output format - for Word: text|markdown|html (default: text); for Excel: table|json|csv (default: table)
- sheet (optional, Excel only): Worksheet name or index (default: first sheet)
- max_rows (optional, Excel only): Maximum rows to read (default: 1000)

Examples:
- Read PDF: { "file_path": "/path/to/report.pdf" }
- Read PDF with prompt: { "file_path": "/path/to/paper.pdf", "prompt": "Summarize the key findings" }
- Read Word: { "file_path": "/path/to/doc.docx", "format": "markdown" }
- Read Excel: { "file_path": "/path/to/data.xlsx", "format": "json", "sheet": "Sheet2" }`,

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the document file (.pdf, .docx, .doc, .xlsx, .xls)',
      },
      // --- PDF params ---
      prompt: {
        type: 'string',
        description: '[PDF] Specific question or instruction for analyzing the PDF',
      },
      // --- Word / Excel params ---
      format: {
        type: 'string',
        description: '[Word] text|markdown|html (default: text); [Excel] table|json|csv (default: table)',
      },
      // --- Excel params ---
      sheet: {
        type: 'string',
        description: '[Excel] Worksheet name or index (default: first sheet)',
      },
      max_rows: {
        type: 'number',
        description: '[Excel] Maximum rows to read (default: 1000)',
      },
    },
    required: ['file_path'],
  },

  requiresPermission: true,
  permissionLevel: 'read',

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const filePath = params.file_path as string;

    if (!filePath || typeof filePath !== 'string') {
      return {
        success: false,
        error: 'file_path is required and must be a string',
      };
    }

    // Extract extension (case-insensitive)
    const dotIndex = filePath.lastIndexOf('.');
    if (dotIndex === -1) {
      return {
        success: false,
        error: `Cannot detect file format: no extension found in "${filePath}". Supported: .pdf, .docx, .doc, .xlsx, .xls`,
      };
    }

    const ext = filePath.substring(dotIndex).toLowerCase();
    const handler = EXTENSION_MAP[ext];

    if (!handler) {
      return {
        success: false,
        error: `Unsupported file format: ${ext}. Supported extensions: ${Object.keys(EXTENSION_MAP).join(', ')}`,
      };
    }

    // Dispatch to the appropriate original tool
    switch (handler) {
      case 'pdf':
        return readPdfTool.execute(params, context);

      case 'docx':
        return readDocxTool.execute(params, context);

      case 'xlsx':
        return readXlsxTool.execute(params, context);

      default:
        return {
          success: false,
          error: `Internal error: unhandled handler type "${handler}"`,
        };
    }
  },
};
