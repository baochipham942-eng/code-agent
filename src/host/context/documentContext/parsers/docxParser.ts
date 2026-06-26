// ============================================================================
// DOCX Parser - Word 文档（复用 mammoth）
// ============================================================================

import type { DocumentParser, DocumentSection, ParsedDocument } from '../types';
import { ParsedDocumentImpl, estimateTokenCount } from '../parsedDocumentImpl';

export class DocxParser implements DocumentParser {
  canParse(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.docx');
  }

  async parse(content: string | Buffer, filePath: string): Promise<ParsedDocument> {
    const sections: DocumentSection[] = [];

    try {
      const mammoth = await import('mammoth');

      let result;
      if (Buffer.isBuffer(content)) {
        result = await mammoth.convertToHtml({ buffer: content });
      } else {
        result = await mammoth.convertToHtml({ path: filePath });
      }

      // 将 HTML 转为纯文本 sections（按 <h1>-<h6> 分段）
      const html = result.value;
      const headingPattern = /<h(\d)>(.+?)<\/h\d>/gi;
      const parts: Array<{ level: number; title: string; startIdx: number }> = [];

      let match;
      while ((match = headingPattern.exec(html)) !== null) {
        parts.push({
          level: parseInt(match[1]),
          title: stripHtml(match[2]),
          startIdx: match.index,
        });
      }

      if (parts.length === 0) {
        // 没有 heading，整个文档作为一个 section
        const text = stripHtml(html);
        sections.push({
          id: 'sec_full',
          title: filePath.split('/').pop() || 'Document',
          content: text,
          type: 'paragraph',
          importance: 0.5,
          tokenEstimate: estimateTokenCount(text),
        });
      } else {
        // 按 heading 分段
        for (let i = 0; i < parts.length; i++) {
          const start = parts[i].startIdx;
          const end = i + 1 < parts.length ? parts[i + 1].startIdx : html.length;
          const sectionHtml = html.substring(start, end);
          const text = stripHtml(sectionHtml);

          sections.push({
            id: `sec_${i}`,
            title: parts[i].title,
            content: text,
            type: 'heading',
            importance: Math.max(0.3, 1.0 - (parts[i].level - 1) * 0.12),
            tokenEstimate: estimateTokenCount(text),
          });
        }

        // 第一个 heading 前的内容
        if (parts[0].startIdx > 0) {
          const preface = stripHtml(html.substring(0, parts[0].startIdx));
          if (preface.trim().length > 0) {
            sections.unshift({
              id: 'sec_preface',
              title: 'Preface',
              content: preface,
              type: 'paragraph',
              importance: 0.6,
              tokenEstimate: estimateTokenCount(preface),
            });
          }
        }
      }
    } catch {
      // mammoth 不可用
      const text = typeof content === 'string' ? content : '[Binary DOCX file - mammoth not available]';
      sections.push({
        id: 'sec_fallback',
        title: 'Document Content',
        content: text,
        type: 'paragraph',
        importance: 0.5,
        tokenEstimate: estimateTokenCount(text),
      });
    }

    return new ParsedDocumentImpl('docx', filePath, sections);
  }
}

/** 简单 HTML 标签清理 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
