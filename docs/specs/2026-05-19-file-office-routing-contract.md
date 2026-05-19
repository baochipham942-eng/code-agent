# File / Office Routing Contract

Date: 2026-05-19
Scope: Agent Neo file, document, spreadsheet, and slide tasks.
Reference source: Marvis file-agent, document-writer, Excel, and PPTX routing patterns.

## Goal

Keep simple file work on light tools, and enter an Office skill only when the task needs document semantics, generation, edits, multi-file transforms, charts, or export validation.

## Routing Rules

| User intent | Default route | Escalate to skill when |
|-------------|---------------|------------------------|
| Find files, inspect folders, search text, locate references | `Glob`, `Grep`, `Read`; for broad text search use shell `rg` through Bash when the native Grep shape is not enough | The user asks to edit, rewrite, generate, convert, summarize a binary document, or combine multiple files |
| Summarize plain text, Markdown, code, logs, config | `Read` plus `Grep` / `rg` for focused evidence | The summary requires structured Office output, tracked edits, tables, slides, or charts |
| Read existing DOCX / PDF / PPTX / XLSX | `ReadDocument` / `read_docx` / `read_pdf` / `read_xlsx` first | Any content edit, regeneration, layout work, cross-file merge, or export is required |
| Edit DOCX / document | `docx` skill after first read | Always use the skill for DOCX edits, review marks, document generation, or OOXML-level changes |
| Excel analysis | `read_xlsx` / `ExcelAutomate read`, then pandas/openpyxl for analysis | Use the `excel` skill for cleaning, formulas, workbook generation, multi-sheet output, charts, or automation of an open workbook |
| Slides / PPTX generation | `frontend-slides` skill through `/ppt` or `skill` | Always use the skill for new decks, PPTX/PDF export, slide images, and chart-heavy presentations |

## Office-Specific Order

1. Excel starts with analysis: read workbook structure, confirm sheets, columns, types, rows, nulls, duplicates, then compute or generate.
2. DOCX, documents, and slides start with source reading or outline shaping, then generation or edits.
3. Existing document edits are incremental by default; do not rebuild a DOCX/PPTX/XLSX just to replace a small part.
4. Generated artifacts must be checked after writing:
   - DOCX: read back paragraphs, headings, key text, table count when possible.
   - XLSX: read back sheets, row counts, key columns, formulas, and chart-bearing sheets.
   - PPTX / slide deck: validate `outline.md`, `slides.json`, image count, and PPTX/PDF file existence; inspect PPTX structure when dependencies allow.
5. Plain search / read / summary should not trigger Office skills only because a file extension appears in the prompt.

## Runtime Boundary

PC App Store and mini-program patterns from Marvis are reference-only for Agent Neo. They may inform product analysis and documentation, but must not be wired into Mac runtime routing, Browser/Desktop control, capability center services, or default tool dispatch.

## Non-Goals

- No change to Capability Center service behavior.
- No change to Browser/Desktop runtime.
- No automatic installation, opening, or control of PC-only apps.
- No legacy `ppt_generate` fallback for decks.
