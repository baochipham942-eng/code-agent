// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const docEditSchema: ToolSchema = {
  name: 'DocEdit',
  description: `Unified document editing tool — atomic incremental edits on Excel, PPT, and Word files.
Auto-detects format from file extension (.xlsx/.xls/.pptx/.docx). Auto-snapshots before editing.
~80% token savings vs full-file regeneration.

## Parameters:
- file_path (required): Path to the document (.xlsx/.pptx/.docx)
- operations (required): Array of edit operations (format-specific, see below)
- dry_run: Preview changes without applying (default: false)

## Excel operations (.xlsx):
- set_cell: { action: "set_cell", sheet?: "Sheet1", cell: "B7", value: 42000, format?: { bold: true } }
- set_range: { action: "set_range", range: "A1:C2", values: [["a","b","c"],[1,2,3]] }
- set_formula: { action: "set_formula", cell: "B8", formula: "=SUM(B2:B7)" }
- insert_rows: { action: "insert_rows", after: 5, data: [["new","row"]] }
- delete_rows: { action: "delete_rows", from: 3, count: 2 }
- insert_columns / delete_columns
- set_style: { action: "set_style", range: "A1:D1", style: { bold: true, fill: "E2EFDA" } }
- rename_sheet / add_sheet / delete_sheet / set_column_width / merge_cells / auto_filter

## PPT operations (.pptx):
Use the ppt_edit tool directly (8 actions: replace_title, replace_content, replace_slide, delete_slide, insert_slide, extract_style, reorder_slides, update_notes).

## Word operations (.docx):
- replace_text: { action: "replace_text", search: "old", replace: "new", all?: true }
- replace_paragraph: { action: "replace_paragraph", index: 2, text: "new content" }
- insert_paragraph: { action: "insert_paragraph", after: 1, text: "new para", style?: "heading2" }
- delete_paragraph: { action: "delete_paragraph", index: 3, count?: 2 }
- replace_heading: { action: "replace_heading", index: 0, text: "New Title" }
- append_paragraph: { action: "append_paragraph", text: "added at end" }
- set_text_style: { action: "set_text_style", search: "important", bold: true, color: "FF0000" }`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the document (.xlsx/.pptx/.docx)',
      },
      operations: {
        type: 'array',
        description: 'Array of edit operations (format-specific)',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview changes without applying (default: false)',
      },
    },
    required: ['file_path', 'operations'],
  },
  category: 'document',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
