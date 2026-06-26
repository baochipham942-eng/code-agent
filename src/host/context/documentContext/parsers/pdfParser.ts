// ============================================================================
// PDF Parser - 复用现有 readPdf 逻辑
// ============================================================================

import type { DocumentParser, DocumentSection, ParsedDocument } from '../types';
import { ParsedDocumentImpl, estimateTokenCount } from '../parsedDocumentImpl';

export class PdfParser implements DocumentParser {
  canParse(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.pdf');
  }

  async parse(content: string | Buffer, filePath: string): Promise<ParsedDocument> {
    const sections: DocumentSection[] = [];

    // content 通常是已提取的文本
    const text = typeof content === 'string' ? content : content.toString('utf-8');

    if (!text || text.trim().length === 0) {
      return new ParsedDocumentImpl('pdf', filePath, []);
    }

    // 按空行分段（PDF 的段落通常由空行分隔）
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);

    // 尝试检测页码标记
    const pagePattern = /^[-—]\s*(\d+)\s*[-—]$/;

    let currentPage = 1;
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i].trim();

      // 检测页码
      const pageMatch = para.match(pagePattern);
      if (pageMatch) {
        currentPage = parseInt(pageMatch[1]);
        continue;
      }

      // 检测标题特征（较短、全大写或以数字开头）
      const isTitle = para.length < 80 && (
        para === para.toUpperCase() ||
        /^\d+\.?\s+/.test(para) ||
        /^(Chapter|Section|Part)\s+/i.test(para)
      );

      sections.push({
        id: `sec_${i}`,
        title: isTitle ? para.substring(0, 60) : `Page ${currentPage}, Paragraph ${i + 1}`,
        content: para,
        type: isTitle ? 'heading' : 'paragraph',
        importance: isTitle ? 0.7 : (i < 3 ? 0.6 : 0.4), // 前几段更重要
        tokenEstimate: estimateTokenCount(para),
      });
    }

    return new ParsedDocumentImpl('pdf', filePath, sections);
  }
}
