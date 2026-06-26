// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readDocumentSchema: ToolSchema = {
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
      prompt: {
        type: 'string',
        description: '[PDF] Specific question or instruction for analyzing the PDF',
      },
      format: {
        type: 'string',
        description:
          '[Word] text|markdown|html (default: text); [Excel] table|json|csv (default: table)',
      },
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
  category: 'network',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
