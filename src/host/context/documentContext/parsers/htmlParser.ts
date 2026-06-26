// ============================================================================
// HTML Parser - HTML/HTM 文件解析
// ============================================================================

import type { DocumentParser, DocumentSection, ParsedDocument } from '../types';
import { ParsedDocumentImpl, estimateTokenCount } from '../parsedDocumentImpl';

export class HtmlParser implements DocumentParser {
  canParse(filePath: string): boolean {
    const ext = filePath.toLowerCase();
    return ext.endsWith('.html') || ext.endsWith('.htm');
  }

  async parse(content: string | Buffer, filePath: string): Promise<ParsedDocument> {
    const text = typeof content === 'string' ? content : content.toString('utf-8');
    const sections: DocumentSection[] = [];

    // 移除 script 和 style 标签及其内容
    const cleaned = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // 按 heading 标签分段
    const headingPattern = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let sectionIdx = 0;

    // 先提取 <title>
    const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      const titleText = this.stripTags(titleMatch[1]).trim();
      if (titleText) {
        sections.push({
          id: `sec_title`,
          title: titleText,
          content: titleText,
          type: 'heading',
          importance: 0.9,
          tokenEstimate: estimateTokenCount(titleText),
        });
      }
    }

    while ((match = headingPattern.exec(cleaned)) !== null) {
      // 提取 heading 之前的文本作为段落
      if (match.index > lastIndex) {
        const beforeText = this.stripTags(cleaned.substring(lastIndex, match.index)).trim();
        if (beforeText.length > 20) {
          sections.push({
            id: `sec_${sectionIdx++}`,
            title: `Paragraph ${sectionIdx}`,
            content: beforeText,
            type: 'paragraph',
            importance: 0.4,
            tokenEstimate: estimateTokenCount(beforeText),
          });
        }
      }

      const headingLevel = parseInt(match[1][1]);
      const headingText = this.stripTags(match[2]).trim();
      if (headingText) {
        sections.push({
          id: `sec_${sectionIdx++}`,
          title: headingText,
          content: headingText,
          type: 'heading',
          importance: Math.max(0.5, 0.9 - (headingLevel - 1) * 0.1),
          tokenEstimate: estimateTokenCount(headingText),
        });
      }

      lastIndex = match.index + match[0].length;
    }

    // 处理最后一段
    if (lastIndex < cleaned.length) {
      const remaining = this.stripTags(cleaned.substring(lastIndex)).trim();
      if (remaining.length > 20) {
        sections.push({
          id: `sec_${sectionIdx++}`,
          title: `Paragraph ${sectionIdx}`,
          content: remaining,
          type: 'paragraph',
          importance: 0.4,
          tokenEstimate: estimateTokenCount(remaining),
        });
      }
    }

    // 如果没有按 heading 分段成功，按整体文本处理
    if (sections.length === 0) {
      const plainText = this.stripTags(cleaned).trim();
      if (plainText) {
        sections.push({
          id: 'sec_0',
          title: 'Content',
          content: plainText,
          type: 'paragraph',
          importance: 0.5,
          tokenEstimate: estimateTokenCount(plainText),
        });
      }
    }

    return new ParsedDocumentImpl('text', filePath, sections);
  }

  private stripTags(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
