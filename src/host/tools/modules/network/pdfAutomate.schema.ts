// Schema-only file (P0-7 方案 A — single source of truth)
// PdfAutomate — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const pdfAutomateSchema: ToolSchema = {
  name: 'PdfAutomate',
  description: `Unified PDF automation tool combining reading, generating, compressing, merging, splitting, table extraction, and conversion.

## Actions:

### generate — Generate a new PDF document
Creates a styled PDF from Markdown content.

Parameters:
- title (required): PDF title
- content (required): Markdown content
- theme: "default" | "academic" | "minimal"
- page_size: "A4" | "Letter" | "Legal"
- output_path: Output file path

### compress — Compress a PDF file
Reduces file size using Ghostscript.

Parameters:
- input_path (required): PDF file path
- output_path: Output file path
- quality: "screen" | "ebook" | "printer" | "prepress"

### read — Read PDF content using vision model
Analyzes PDF content using Gemini 2.0.

Parameters:
- file_path (required): PDF file path
- prompt: Specific question or instruction

### merge — Merge multiple PDFs into one
Parameters:
- input_files (required): Array of PDF file paths
- output_path (required): Output file path

### split — Split PDF by page ranges
Parameters:
- input_path (required): PDF file path
- ranges (required): Array of { start, end, output } (0-indexed pages)

### extract_tables — Extract tables from PDF
Parameters:
- input_path (required): PDF file path
- pages: Array of page numbers (0-indexed, optional)

### convert_to_docx — Convert PDF to Word document
Parameters:
- input_path (required): PDF file path
- output_path: Output DOCX file path
- start_page: Start page (0-indexed)
- end_page: End page (exclusive)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['generate', 'compress', 'read', 'merge', 'split', 'extract_tables', 'convert_to_docx'],
        description: 'The PDF action to perform',
      },
      // generate params
      title: { type: 'string', description: '[generate] PDF title' },
      content: { type: 'string', description: '[generate] Markdown content' },
      theme: { type: 'string', enum: ['default', 'academic', 'minimal'], description: '[generate] Theme' },
      page_size: { type: 'string', enum: ['A4', 'Letter', 'Legal'], description: '[generate] Page size' },
      author: { type: 'string', description: '[generate] Author name' },
      // compress params
      input_path: { type: 'string', description: '[compress/split/extract_tables/convert_to_docx] Input PDF path' },
      quality: { type: 'string', enum: ['screen', 'ebook', 'printer', 'prepress'], description: '[compress] Quality level' },
      // read params
      file_path: { type: 'string', description: '[read] PDF file path' },
      prompt: { type: 'string', description: '[read] Analysis instruction' },
      // merge params
      input_files: { type: 'array', items: { type: 'string' }, description: '[merge] Array of PDF file paths' },
      // split params
      ranges: { type: 'array', description: '[split] Array of { start, end, output }' },
      // extract_tables params
      pages: { type: 'array', items: { type: 'number' }, description: '[extract_tables] Page numbers (0-indexed)' },
      // shared
      output_path: { type: 'string', description: 'Output file path' },
      // convert_to_docx params
      start_page: { type: 'number', description: '[convert_to_docx] Start page (0-indexed)' },
      end_page: { type: 'number', description: '[convert_to_docx] End page (exclusive)' },
    },
    required: ['action'],
  },
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
