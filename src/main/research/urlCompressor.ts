// ============================================================================
// URL Compressor - 研究过程中的 URL 压缩/展开
// ============================================================================
//
// 灵感来源: Google gemini-fullstack-langgraph-quickstart 的 resolve_urls()
// 研究阶段用短 ID 替代长 URL 节省 token，报告阶段展开为完整 URL
// ============================================================================

export interface UrlEntry {
  id: string;       // e.g. "src1"
  url: string;      // full URL
  title?: string;   // page title if available
  domain?: string;  // extracted domain
  accessTime: number; // timestamp
}

export class UrlCompressor {
  private urlMap: Map<string, UrlEntry> = new Map();
  private reverseMap: Map<string, string> = new Map(); // url -> id
  private counter: number = 0;
  private readonly prefix: string;

  constructor(prefix: string = 'src') {
    this.prefix = prefix;
  }

  /**
   * 压缩 URL 为短 ID
   * 如果 URL 已存在，返回之前的 ID（去重）
   */
  compress(url: string, title?: string): string {
    // 已存在则返回旧 ID
    const existingId = this.reverseMap.get(url);
    if (existingId) {
      // 更新 title（如果之前没有）
      if (title) {
        const entry = this.urlMap.get(existingId);
        if (entry && !entry.title) {
          entry.title = title;
        }
      }
      return existingId;
    }

    // 生成新 ID
    this.counter++;
    const id = `${this.prefix}${this.counter}`;
    const domain = this.extractDomain(url);

    const entry: UrlEntry = {
      id,
      url,
      title,
      domain,
      accessTime: Date.now(),
    };

    this.urlMap.set(id, entry);
    this.reverseMap.set(url, id);

    return id;
  }

  /**
   * 批量压缩文本中的 URL
   * 将文本中的 URL 替换为 [srcN] 格式
   */
  compressText(text: string): string {
    // 匹配 http/https URL
    const urlRegex = /https?:\/\/[^\s\])<>"']+/g;
    return text.replace(urlRegex, (url: string, offset: number, fullText: string) => {
      const id = this.compress(url);
      // 如果前一个字符不是空格/换行/[，添加空格防止与中文粘连
      const prevChar = offset > 0 ? fullText[offset - 1] : ' ';
      const needsSpace = prevChar !== ' ' && prevChar !== '\n' && prevChar !== '[' && prevChar !== '(';
      return `${needsSpace ? ' ' : ''}[${id}]`;
    });
  }

  /**
   * 展开短 ID 为完整 URL
   */
  expand(id: string): string | undefined {
    return this.urlMap.get(id)?.url;
  }

  /**
   * 展开文本中的所有短 ID 引用
   * 将 [srcN] 替换为完整 URL
   */
  expandText(text: string): string {
    const idRegex = new RegExp(`\\[${this.prefix}:?(\\d+)\\]`, 'g');
    return text.replace(idRegex, (match, num) => {
      const id = `${this.prefix}${num}`;
      const entry = this.urlMap.get(id);
      if (!entry) return match;

      // 生成 markdown link
      if (entry.title) {
        return `[${entry.title}](${entry.url})`;
      }
      return `[${id}](${entry.url})`;
    });
  }

  /**
   * 生成来源列表（用于报告末尾）
   */
  generateSourceList(): string {
    if (this.urlMap.size === 0) return '';

    const lines: string[] = ['## Sources', ''];

    for (const [id, entry] of this.urlMap) {
      const titlePart = entry.title ? ` - ${entry.title}` : '';
      const domainPart = entry.domain ? ` (${entry.domain})` : '';
      lines.push(`- **[${id}]** ${entry.url}${titlePart}${domainPart}`);
    }

    return lines.join('\n');
  }

  /**
   * 获取所有 URL 条目
   */
  getEntries(): UrlEntry[] {
    return Array.from(this.urlMap.values());
  }

  /**
   * 获取条目数
   */
  get size(): number {
    return this.urlMap.size;
  }

  /**
   * 获取估算的 token 节省量
   * 假设平均 URL 长度 80 chars，短 ID 约 6 chars
   */
  getTokenSavings(): { originalChars: number; compressedChars: number; savedChars: number } {
    let originalChars = 0;
    let compressedChars = 0;

    for (const [id, entry] of this.urlMap) {
      originalChars += entry.url.length;
      compressedChars += id.length + 2; // [srcN]
    }

    return {
      originalChars,
      compressedChars,
      savedChars: originalChars - compressedChars,
    };
  }

  /**
   * 重置压缩器
   */
  reset(): void {
    this.urlMap.clear();
    this.reverseMap.clear();
    this.counter = 0;
  }

  private extractDomain(url: string): string | undefined {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
}
