// ============================================================================
// Document Context Types
// ============================================================================

export type DocumentType = 'code' | 'excel' | 'docx' | 'markdown' | 'pdf' | 'text' | 'unknown';

export type SectionType = 'heading' | 'code' | 'table' | 'paragraph' | 'formula' | 'list' | 'import';

export interface DocumentSection {
  id: string;
  title: string;
  content: string;
  type: SectionType;
  /** 重要性权重 0-1，压缩时高 importance 的 section 最后被删 */
  importance: number;
  tokenEstimate: number;
  children?: DocumentSection[];
  /** 在原文中的起始行号 */
  startLine?: number;
  /** 在原文中的结束行号 */
  endLine?: number;
}

export interface ParsedDocument {
  type: DocumentType;
  path: string;
  sections: DocumentSection[];
  totalTokens: number;

  /**
   * 获取 token 预算内最重要的 sections
   */
  getTopSections(tokenBudget: number): DocumentSection[];

  /**
   * 压缩为字符串，按 importance 排序，在 token 预算内
   */
  toCompressedString(tokenBudget: number): string;
}

/**
 * 文档解析器接口 - 新格式只需实现此接口
 */
export interface DocumentParser {
  /** 是否可以解析该文件 */
  canParse(filePath: string): boolean;
  /** 解析文件内容为结构化文档 */
  parse(content: string | Buffer, filePath: string): Promise<ParsedDocument>;
}
