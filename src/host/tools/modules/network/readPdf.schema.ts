// Schema-only file (P0-7 方案 A — single source of truth)
import type { UntrustedContentToolSchema } from '../../../protocol/tools';

export const readPdfSchema: UntrustedContentToolSchema = {
  name: 'read_pdf',
  description: `Read PDF files. With OPENROUTER_API_KEY, uses a vision model (Gemini 2.0). Without it, extracts selectable text via local pdftotext (prompt is ignored on that fallback).

Parameters:
- file_path: Absolute path to the PDF file
- prompt: (Optional) Specific question for the vision path; ignored by local text extract

Returns:
- Vision analysis when OpenRouter is configured, or raw selectable text on the pdftotext fallback

Best for:
- Reading text-based PDFs (technical docs, code, reports)
- Processing scanned documents and images (vision path)
- Analyzing PDF forms, diagrams and charts (vision path)`,
  outputSchema: { type: 'string' },
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
  readsUntrustedContent: 'block',
  readOnly: true,
  allowInPlanMode: true,
};
