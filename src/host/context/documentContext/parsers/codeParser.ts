// ============================================================================
// Code Parser - TypeScript/JavaScript/Python 等代码文件
// ============================================================================

import type { DocumentParser, DocumentSection, ParsedDocument } from '../types';
import { ParsedDocumentImpl, estimateTokenCount } from '../parsedDocumentImpl';

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.vue', '.svelte',
]);

// 正则：检测函数/类/接口定义
const SECTION_PATTERNS = [
  // TypeScript/JavaScript
  /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+\w+/,
  // Python
  /^(?:class|def|async\s+def)\s+\w+/,
  // Go
  /^(?:func|type)\s+\w+/,
  // Rust
  /^(?:pub\s+)?(?:fn|struct|enum|trait|impl|mod)\s+\w+/,
  // Java/Kotlin
  /^(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum|record)\s+\w+/,
];

export class CodeParser implements DocumentParser {
  canParse(filePath: string): boolean {
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    return CODE_EXTENSIONS.has(ext.toLowerCase());
  }

  async parse(content: string | Buffer, filePath: string): Promise<ParsedDocument> {
    const text = typeof content === 'string' ? content : content.toString('utf-8');
    const lines = text.split('\n');
    const sections: DocumentSection[] = [];

    // 1. 提取 import 区域
    let importEnd = 0;
    for (let i = 0; i < lines.length && i < 50; i++) {
      const line = lines[i].trim();
      if (line.startsWith('import ') || line.startsWith('from ') || line.startsWith('require(') || line.startsWith('export ') && line.includes(' from ')) {
        importEnd = i + 1;
      } else if (line === '' && importEnd > 0) {
        continue; // Skip blank lines between imports
      } else if (importEnd > 0) {
        break;
      }
    }

    if (importEnd > 0) {
      const importContent = lines.slice(0, importEnd).join('\n');
      sections.push({
        id: `sec_imports`,
        title: 'Imports',
        content: importContent,
        type: 'import',
        importance: 0.3,
        tokenEstimate: estimateTokenCount(importContent),
        startLine: 1,
        endLine: importEnd,
      });
    }

    // 2. 按函数/类定义分段
    let currentSection: { title: string; startLine: number; lines: string[] } | null = null;

    for (let i = importEnd; i < lines.length; i++) {
      const line = lines[i];
      const isDefinition = SECTION_PATTERNS.some(p => p.test(line.trim()));

      if (isDefinition) {
        // 保存之前的 section
        if (currentSection && currentSection.lines.length > 0) {
          const content = currentSection.lines.join('\n');
          sections.push({
            id: `sec_${sections.length}`,
            title: currentSection.title,
            content,
            type: 'code',
            importance: this.estimateImportance(currentSection.title, content),
            tokenEstimate: estimateTokenCount(content),
            startLine: currentSection.startLine,
            endLine: i,
          });
        }
        currentSection = {
          title: line.trim().substring(0, 80),
          startLine: i + 1,
          lines: [line],
        };
      } else if (currentSection) {
        currentSection.lines.push(line);
      }
    }

    // 保存最后一个 section
    if (currentSection && currentSection.lines.length > 0) {
      const content = currentSection.lines.join('\n');
      sections.push({
        id: `sec_${sections.length}`,
        title: currentSection.title,
        content,
        type: 'code',
        importance: this.estimateImportance(currentSection.title, content),
        tokenEstimate: estimateTokenCount(content),
        startLine: currentSection.startLine,
        endLine: lines.length,
      });
    }

    // 如果没有找到任何定义，把整个文件作为一个 section
    if (sections.length === 0 || (sections.length === 1 && sections[0].type === 'import')) {
      const fullContent = lines.slice(importEnd).join('\n');
      if (fullContent.trim().length > 0) {
        sections.push({
          id: `sec_full`,
          title: filePath.split('/').pop() || 'code',
          content: fullContent,
          type: 'code',
          importance: 0.5,
          tokenEstimate: estimateTokenCount(fullContent),
          startLine: importEnd + 1,
          endLine: lines.length,
        });
      }
    }

    return new ParsedDocumentImpl('code', filePath, sections);
  }

  private estimateImportance(title: string, content: string): number {
    // export 的定义更重要
    if (title.startsWith('export ')) return 0.8;
    // class 和 interface 比函数重要
    if (/class\s|interface\s/.test(title)) return 0.7;
    // 较长的函数可能更重要
    const lineCount = content.split('\n').length;
    if (lineCount > 30) return 0.6;
    return 0.5;
  }
}
