// ============================================================================
// Document Context Service - 统一文档理解接口
// ============================================================================
//
// 解析器注册表模式，新格式只需实现 DocumentParser 接口。
// Lazy 初始化：只在首次解析文档时创建。

import { createLogger } from '../../services/infra/logger';
import type { DocumentParser, ParsedDocument } from './types';
import { CodeParser } from './parsers/codeParser';
import { MarkdownParser } from './parsers/markdownParser';
import { ExcelParser } from './parsers/excelParser';
import { DocxParser } from './parsers/docxParser';
import { PdfParser } from './parsers/pdfParser';
import { HtmlParser } from './parsers/htmlParser';

const logger = createLogger('DocumentContextService');

export class DocumentContextService {
  private parsers: DocumentParser[] = [];
  private initialized = false;

  /**
   * 注册解析器（延迟初始化，首次调用 parse 时自动注册内置解析器）
   */
  registerParser(parser: DocumentParser): void {
    this.parsers.push(parser);
  }

  /**
   * 解析文件为结构化文档
   *
   * @param content - 文件内容（字符串或 Buffer）
   * @param filePath - 文件路径（用于判断类型）
   * @returns ParsedDocument 或 null（无匹配解析器）
   */
  async parse(content: string | Buffer, filePath: string): Promise<ParsedDocument | null> {
    this.ensureInitialized();

    // 找到第一个能解析该文件的解析器
    for (const parser of this.parsers) {
      if (parser.canParse(filePath)) {
        try {
          const doc = await parser.parse(content, filePath);
          logger.debug('Document parsed', {
            filePath,
            type: doc.type,
            sections: doc.sections.length,
            totalTokens: doc.totalTokens,
          });
          return doc;
        } catch (error) {
          logger.error('Parser failed', { filePath, error });
          // 继续尝试下一个解析器
        }
      }
    }

    logger.debug('No parser found for file', { filePath });
    return null;
  }

  /**
   * 检查是否有解析器支持该文件
   */
  canParse(filePath: string): boolean {
    this.ensureInitialized();
    return this.parsers.some(p => p.canParse(filePath));
  }

  /**
   * 获取已注册的解析器数量
   */
  getParserCount(): number {
    this.ensureInitialized();
    return this.parsers.length;
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 注册内置解析器
    this.parsers.push(
      new CodeParser(),
      new MarkdownParser(),
      new ExcelParser(),
      new DocxParser(),
      new PdfParser(),
      new HtmlParser(),
    );

    logger.debug('DocumentContextService initialized with built-in parsers', {
      count: this.parsers.length,
    });
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let instance: DocumentContextService | null = null;

export function getDocumentContextService(): DocumentContextService {
  if (!instance) {
    instance = new DocumentContextService();
  }
  return instance;
}

export function resetDocumentContextService(): void {
  instance = null;
}
