// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readPdfSchema: ToolSchema = {
  name: 'read_pdf',
  description: `Read PDF files using vision model (Gemini 2.0).

Parameters:
- file_path: Absolute path to the PDF file
- prompt: (Optional) Specific question or instruction for analyzing the PDF

Returns:
- AI-generated analysis/transcription of the PDF content

Best for:
- Reading text-based PDFs (technical docs, code, reports)
- Processing scanned documents and images
- Analyzing PDF forms, diagrams and charts`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the PDF file',
      },
      prompt: {
        type: 'string',
        description: 'Specific question or instruction for analyzing the PDF',
      },
    },
    required: ['file_path'],
  },
  category: 'network',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
