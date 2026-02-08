// ============================================================================
// ParsedDocument Implementation
// ============================================================================

import type { DocumentType, DocumentSection, ParsedDocument } from './types';

/**
 * ParsedDocument 默认实现
 */
export class ParsedDocumentImpl implements ParsedDocument {
  type: DocumentType;
  path: string;
  sections: DocumentSection[];
  totalTokens: number;

  constructor(type: DocumentType, path: string, sections: DocumentSection[]) {
    this.type = type;
    this.path = path;
    this.sections = sections;
    this.totalTokens = sections.reduce((sum, s) => sum + s.tokenEstimate, 0);
  }

  getTopSections(tokenBudget: number): DocumentSection[] {
    // 按 importance 降序排列
    const sorted = [...this.sections].sort((a, b) => b.importance - a.importance);

    const result: DocumentSection[] = [];
    let usedTokens = 0;

    for (const section of sorted) {
      if (usedTokens + section.tokenEstimate <= tokenBudget) {
        result.push(section);
        usedTokens += section.tokenEstimate;
      }
    }

    // 恢复原始顺序（按 startLine 或数组位置）
    result.sort((a, b) => (a.startLine || 0) - (b.startLine || 0));

    return result;
  }

  toCompressedString(tokenBudget: number): string {
    const topSections = this.getTopSections(tokenBudget);

    if (topSections.length === 0) {
      return `[Document: ${this.path} (${this.totalTokens} tokens, exceeds budget ${tokenBudget})]`;
    }

    const parts: string[] = [];
    for (const section of topSections) {
      if (section.title) {
        parts.push(`## ${section.title}`);
      }
      parts.push(section.content);
    }

    const text = parts.join('\n\n');
    const omitted = this.sections.length - topSections.length;

    if (omitted > 0) {
      return text + `\n\n[... ${omitted} sections omitted due to token budget]`;
    }

    return text;
  }
}

/**
 * 估算 token 数（简易：4 字符 ≈ 1 token）
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
