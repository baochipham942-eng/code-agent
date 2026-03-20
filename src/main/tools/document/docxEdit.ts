// ============================================================================
// DOCX Edit - Atomic paragraph/section level editing for Word documents
// ============================================================================
// DOCX is ZIP + XML (like PPTX). We use JSZip to manipulate document.xml
// directly for incremental edits instead of full-file regeneration.
// ============================================================================

import * as fs from 'fs';
import type { ToolExecutionResult } from '../types';
import { createSnapshot, restoreLatest } from './snapshotManager';
import { enableTrackChanges, ensurePeopleXml, wrapInsertion, wrapDeletion } from './docxTrackChanges';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DocxEditOperation =
  | { action: 'replace_text'; search: string; replace: string; all?: boolean }
  | { action: 'replace_paragraph'; index: number; text: string }
  | { action: 'insert_paragraph'; after: number; text: string; style?: 'normal' | 'heading1' | 'heading2' | 'heading3' }
  | { action: 'delete_paragraph'; index: number; count?: number }
  | { action: 'replace_heading'; index: number; text: string }
  | { action: 'append_paragraph'; text: string; style?: 'normal' | 'heading1' | 'heading2' | 'heading3' }
  | { action: 'set_text_style'; search: string; bold?: boolean; italic?: boolean; color?: string }
  | { action: 'track_insert'; after: number; text: string; author?: string; date?: string }
  | { action: 'track_delete'; search: string; author?: string; date?: string }
  | { action: 'suggest_replace'; search: string; replace: string; author?: string; date?: string };

export interface DocxEditParams {
  file_path: string;
  operations: DocxEditOperation[];
  dry_run?: boolean;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const HEADING_STYLE_MAP: Record<string, string> = {
  heading1: 'Heading1',
  heading2: 'Heading2',
  heading3: 'Heading3',
};

function buildParagraphXml(text: string, style?: string): string {
  const escaped = escapeXml(text);
  const pStyle = style && HEADING_STYLE_MAP[style]
    ? `<w:pPr><w:pStyle w:val="${HEADING_STYLE_MAP[style]}"/></w:pPr>`
    : '';
  return `<w:p>${pStyle}<w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
}

// ---------------------------------------------------------------------------
// Operation executors
// ---------------------------------------------------------------------------

function execReplaceText(xml: string, op: Extract<DocxEditOperation, { action: 'replace_text' }>): { xml: string; desc: string } {
  const searchEscaped = escapeXml(op.search);
  const replaceEscaped = escapeXml(op.replace);

  // Text in DOCX XML is inside <w:t> tags
  // Simple approach: replace text content within <w:t> tags
  let count = 0;
  const result = xml.replace(new RegExp(`(<w:t[^>]*>)([^<]*)(</w:t>)`, 'g'), (match, open, content, close) => {
    if (content.includes(searchEscaped)) {
      if (!op.all && count > 0) return match;
      count++;
      return open + content.replace(
        op.all ? new RegExp(escapeRegExp(searchEscaped), 'g') : searchEscaped,
        replaceEscaped
      ) + close;
    }
    return match;
  });

  return { xml: result, desc: `Replaced "${op.search}" → "${op.replace}" (${count} occurrence${count !== 1 ? 's' : ''})` };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function execReplaceParagraph(xml: string, op: Extract<DocxEditOperation, { action: 'replace_paragraph' }>): { xml: string; desc: string } {
  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  if (op.index < 0 || op.index >= paragraphs.length) {
    throw new Error(`Paragraph index ${op.index} out of range (0-${paragraphs.length - 1})`);
  }
  const newP = buildParagraphXml(op.text);
  const result = xml.replace(paragraphs[op.index], newP);
  return { xml: result, desc: `Replaced paragraph ${op.index}` };
}

function execInsertParagraph(xml: string, op: Extract<DocxEditOperation, { action: 'insert_paragraph' }>): { xml: string; desc: string } {
  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  if (paragraphs.length === 0) {
    throw new Error('No paragraphs found in document');
  }
  if (op.after < -1 || op.after >= paragraphs.length) {
    throw new Error(`Paragraph index ${op.after} out of range (-1 to ${paragraphs.length - 1})`);
  }
  const newP = buildParagraphXml(op.text, op.style);
  if (op.after === -1) {
    // Insert at beginning - before first paragraph
    const first = paragraphs[0]!;
    const result = xml.replace(first, newP + first);
    return { xml: result, desc: `Inserted paragraph at beginning` };
  }
  const target = paragraphs[op.after]!;
  const result = xml.replace(target, target + newP);
  return { xml: result, desc: `Inserted paragraph after ${op.after}` };
}

function execDeleteParagraph(xml: string, op: Extract<DocxEditOperation, { action: 'delete_paragraph' }>): { xml: string; desc: string } {
  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  const count = op.count || 1;
  if (op.index < 0 || op.index + count > paragraphs.length) {
    throw new Error(`Cannot delete ${count} paragraph(s) starting at index ${op.index} (total: ${paragraphs.length})`);
  }
  let result = xml;
  for (let i = op.index + count - 1; i >= op.index; i--) {
    result = result.replace(paragraphs[i], '');
  }
  return { xml: result, desc: `Deleted ${count} paragraph(s) at index ${op.index}` };
}

function execReplaceHeading(xml: string, op: Extract<DocxEditOperation, { action: 'replace_heading' }>): { xml: string; desc: string } {
  // Find paragraphs that contain heading styles
  const headingPattern = /<w:p\b[^>]*>[\s\S]*?<w:pStyle\s+w:val="Heading\d"[^/]*\/>[\s\S]*?<\/w:p>/g;
  const headings = xml.match(headingPattern) || [];
  if (op.index < 0 || op.index >= headings.length) {
    throw new Error(`Heading index ${op.index} out of range (0-${headings.length - 1})`);
  }
  // Replace text content within the heading, preserve style
  const heading = headings[op.index];
  const escaped = escapeXml(op.text);
  const updated = heading.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, `<w:t xml:space="preserve">${escaped}</w:t>`);
  const result = xml.replace(heading, updated);
  return { xml: result, desc: `Replaced heading ${op.index}: "${op.text}"` };
}

function execAppendParagraph(xml: string, op: Extract<DocxEditOperation, { action: 'append_paragraph' }>): { xml: string; desc: string } {
  const newP = buildParagraphXml(op.text, op.style);
  // Insert before </w:body>
  const result = xml.replace('</w:body>', newP + '</w:body>');
  return { xml: result, desc: `Appended paragraph: "${op.text.substring(0, 40)}..."` };
}

function execSetTextStyle(xml: string, op: Extract<DocxEditOperation, { action: 'set_text_style' }>): { xml: string; desc: string } {
  const searchEscaped = escapeXml(op.search);
  let count = 0;

  // Find <w:r> elements containing the search text and add/modify <w:rPr>
  const result = xml.replace(/<w:r>([\s\S]*?)<\/w:r>/g, (match, content) => {
    if (!content.includes(searchEscaped)) return match;
    count++;

    // Build run properties
    const props: string[] = [];
    if (op.bold) props.push('<w:b/>');
    if (op.italic) props.push('<w:i/>');
    if (op.color) props.push(`<w:color w:val="${op.color}"/>`);

    if (props.length === 0) return match;

    const rPr = `<w:rPr>${props.join('')}</w:rPr>`;
    // Remove existing rPr if any, add new one
    const cleaned = content.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '');
    return `<w:r>${rPr}${cleaned}</w:r>`;
  });

  return { xml: result, desc: `Styled "${op.search}" (${count} run${count !== 1 ? 's' : ''})` };
}

// ---------------------------------------------------------------------------
// Track Changes executors
// ---------------------------------------------------------------------------

function execTrackInsert(xml: string, op: Extract<DocxEditOperation, { action: 'track_insert' }>, zip: any): { xml: string; desc: string } {
  const author = op.author || 'Code Agent';
  const insertion = wrapInsertion(op.text, author, op.date);

  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  if (op.after < -1 || op.after >= paragraphs.length) {
    throw new Error(`Paragraph index ${op.after} out of range (-1 to ${paragraphs.length - 1})`);
  }

  // Wrap insertion in a paragraph
  const insertionP = `<w:p>${insertion}</w:p>`;

  let result: string;
  if (op.after === -1) {
    const first = paragraphs[0]!;
    result = xml.replace(first, insertionP + first);
  } else {
    const target = paragraphs[op.after]!;
    result = xml.replace(target, target + insertionP);
  }

  // Enable track changes in settings
  void enableTrackChanges(zip);
  void ensurePeopleXml(zip, author);

  return { xml: result, desc: `Track insert after paragraph ${op.after}: "${op.text.substring(0, 40)}..."` };
}

function execTrackDelete(xml: string, op: Extract<DocxEditOperation, { action: 'track_delete' }>, zip: any): { xml: string; desc: string } {
  const author = op.author || 'Code Agent';
  const searchEscaped = escapeXml(op.search);
  let count = 0;

  // Find <w:r> elements containing the search text and wrap with <w:del>
  const result = xml.replace(/<w:r>([\s\S]*?)<\/w:r>/g, (match, content) => {
    if (!content.includes(searchEscaped)) return match;
    count++;

    const deletion = wrapDeletion(op.search, author, op.date);
    return deletion;
  });

  void enableTrackChanges(zip);
  void ensurePeopleXml(zip, author);

  return { xml: result, desc: `Track delete "${op.search}" (${count} occurrence${count !== 1 ? 's' : ''})` };
}

function execSuggestReplace(xml: string, op: Extract<DocxEditOperation, { action: 'suggest_replace' }>, zip: any): { xml: string; desc: string } {
  const author = op.author || 'Code Agent';
  const searchEscaped = escapeXml(op.search);
  let count = 0;

  const result = xml.replace(/<w:r>([\s\S]*?)<\/w:r>/g, (match, content) => {
    if (!content.includes(searchEscaped)) return match;
    count++;

    // Generate deletion + insertion pair
    const deletion = wrapDeletion(op.search, author, op.date);
    const insertion = wrapInsertion(op.replace, author, op.date);
    return deletion + insertion;
  });

  void enableTrackChanges(zip);
  void ensurePeopleXml(zip, author);

  return { xml: result, desc: `Suggest replace "${op.search}" → "${op.replace}" (${count} occurrence${count !== 1 ? 's' : ''})` };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function executeDocxEdit(
  params: DocxEditParams,
): Promise<ToolExecutionResult> {
  const { file_path, operations, dry_run } = params;

  if (!fs.existsSync(file_path)) {
    return { success: false, error: `File not found: ${file_path}` };
  }

  if (!operations || operations.length === 0) {
    return { success: false, error: 'No operations provided' };
  }

  if (dry_run) {
    const preview = operations.map((op, i) => `${i + 1}. [${op.action}] ${JSON.stringify(op)}`);
    return {
      success: true,
      output: `Dry run — ${operations.length} operation(s) would be applied:\n${preview.join('\n')}`,
    };
  }

  const snapshot = createSnapshot(file_path, `docx-edit: ${operations.length} ops`);

  try {
    const JSZip = require('jszip');
    const data = fs.readFileSync(file_path);
    const zip = await JSZip.loadAsync(data);

    const docXmlFile = 'word/document.xml';
    if (!zip.files[docXmlFile]) {
      return { success: false, error: 'Invalid DOCX: word/document.xml not found' };
    }

    let xml: string = await zip.files[docXmlFile].async('string');
    const results: string[] = [];

    for (const op of operations) {
      let result: { xml: string; desc: string };

      switch (op.action) {
        case 'replace_text':
          result = execReplaceText(xml, op);
          break;
        case 'replace_paragraph':
          result = execReplaceParagraph(xml, op);
          break;
        case 'insert_paragraph':
          result = execInsertParagraph(xml, op);
          break;
        case 'delete_paragraph':
          result = execDeleteParagraph(xml, op);
          break;
        case 'replace_heading':
          result = execReplaceHeading(xml, op);
          break;
        case 'append_paragraph':
          result = execAppendParagraph(xml, op);
          break;
        case 'set_text_style':
          result = execSetTextStyle(xml, op);
          break;
        case 'track_insert':
          result = execTrackInsert(xml, op, zip);
          break;
        case 'track_delete':
          result = execTrackDelete(xml, op, zip);
          break;
        case 'suggest_replace':
          result = execSuggestReplace(xml, op, zip);
          break;
        default:
          throw new Error(`Unknown action: ${(op as DocxEditOperation).action}`);
      }

      xml = result.xml;
      results.push(result.desc);
    }

    // Write back
    zip.file(docXmlFile, xml);
    const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(file_path, outputBuffer);

    const stats = fs.statSync(file_path);

    return {
      success: true,
      output: `DOCX edited successfully (${operations.length} operations):\n${results.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}\n\nFile: ${file_path} (${(stats.size / 1024).toFixed(1)} KB)\nSnapshot: ${snapshot.id}`,
      outputPath: file_path,
      metadata: {
        filePath: file_path,
        snapshotId: snapshot.id,
        operationCount: operations.length,
        operations: results,
      },
    };
  } catch (error: unknown) {
    restoreLatest(file_path);
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `DOCX edit failed (auto-restored from snapshot ${snapshot.id}): ${message}`,
      metadata: { snapshotId: snapshot.id },
    };
  }
}
