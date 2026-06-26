// ============================================================================
// Markdown Parser - Markdown 文档按 heading 分段
// ============================================================================

import type { DocumentParser, DocumentSection, ParsedDocument } from '../types';
import { ParsedDocumentImpl, estimateTokenCount } from '../parsedDocumentImpl';

const MD_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

export class MarkdownParser implements DocumentParser {
  canParse(filePath: string): boolean {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    return MD_EXTENSIONS.has(ext.toLowerCase());
  }

  async parse(content: string | Buffer, filePath: string): Promise<ParsedDocument> {
    const text = typeof content === 'string' ? content : content.toString('utf-8');
    const lines = text.split('\n');
    const sections: DocumentSection[] = [];

    let currentHeading = '';
    let currentLevel = 0;
    let currentLines: string[] = [];
    let currentStartLine = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

      if (headingMatch) {
        // 保存之前的 section
        if (currentLines.length > 0) {
          const content = currentLines.join('\n').trim();
          if (content.length > 0) {
            sections.push({
              id: `sec_${sections.length}`,
              title: currentHeading || '(untitled)',
              content,
              type: currentHeading ? 'heading' : 'paragraph',
              importance: this.importanceByLevel(currentLevel, content),
              tokenEstimate: estimateTokenCount(content),
              startLine: currentStartLine,
              endLine: i,
            });
          }
        }

        currentHeading = headingMatch[2].trim();
        currentLevel = headingMatch[1].length;
        currentLines = [line];
        currentStartLine = i + 1;
      } else {
        currentLines.push(line);
      }
    }

    // 保存最后一个 section
    if (currentLines.length > 0) {
      const content = currentLines.join('\n').trim();
      if (content.length > 0) {
        sections.push({
          id: `sec_${sections.length}`,
          title: currentHeading || '(untitled)',
          content,
          type: 'heading',
          importance: this.importanceByLevel(currentLevel, content),
          tokenEstimate: estimateTokenCount(content),
          startLine: currentStartLine,
          endLine: lines.length,
        });
      }
    }

    return new ParsedDocumentImpl('markdown', filePath, sections);
  }

  private importanceByLevel(level: number, content: string): number {
    // h1 最重要，h6 最不重要
    const baseImportance = Math.max(0.3, 1.0 - (level - 1) * 0.12);

    // 包含代码块的 section 更重要
    if (content.includes('```')) {
      return Math.min(1, baseImportance + 0.1);
    }

    // 包含表格的 section 更重要
    if (content.includes('|---') || content.includes('| ---')) {
      return Math.min(1, baseImportance + 0.05);
    }

    return baseImportance;
  }
}
