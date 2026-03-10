// ============================================================================
// Academic Search Tool - 学术搜索工具
// 整合 Exa AI 的学术搜索能力，支持 arXiv、Google Scholar 等来源
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AcademicSearch');

interface AcademicSearchParams {
  query: string;
  limit?: number;
  source?: 'arxiv' | 'all';
  sort_by?: 'relevance' | 'date';
  year_from?: number;
  year_to?: number;
}

interface PaperResult {
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  source: string;
  published_date?: string;
  citations?: number;
  pdf_url?: string;
}

/**
 * 使用 Exa MCP 搜索学术论文
 * 注意：需要 MCP 客户端已连接
 */
async function searchWithExaMCP(
  context: ToolContext,
  query: string,
  limit: number
): Promise<PaperResult[]> {
  // 构建学术搜索查询
  const academicQuery = `academic paper research: ${query}`;

  try {
    // 通过 MCP 调用 Exa 搜索
    const mcpClient = (context as any).mcpClient;
    if (!mcpClient) {
      logger.warn('MCP client not available');
      return [];
    }

    const result = await mcpClient.callTool('exa', 'web_search_exa', {
      query: academicQuery,
      numResults: limit,
    });

    if (result?.results) {
      return result.results.map((r: any) => ({
        title: r.title || 'Unknown Title',
        authors: [],  // Exa 不直接提供作者
        abstract: r.text || r.snippet || '',
        url: r.url,
        source: 'exa',
        published_date: r.publishedDate,
      }));
    }

    return [];
  } catch (error) {
    logger.error('Exa MCP search failed', { error: (error as Error).message });
    return [];
  }
}

/**
 * 使用 arXiv API 直接搜索
 */
async function searchArxiv(query: string, limit: number): Promise<PaperResult[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`arXiv API error: ${response.status}`);
    }

    const xmlText = await response.text();

    // 简单的 XML 解析
    const entries: PaperResult[] = [];
    const entryMatches = xmlText.matchAll(/<entry>([\s\S]*?)<\/entry>/g);

    for (const match of entryMatches) {
      const entry = match[1];

      // 提取字段
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, ' ') || '';
      const abstract = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, ' ') || '';
      const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || '';
      const arxivId = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || '';

      // 提取作者
      const authors: string[] = [];
      const authorMatches = entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g);
      for (const authorMatch of authorMatches) {
        authors.push(authorMatch[1].trim());
      }

      // 提取 PDF 链接
      const pdfMatch = entry.match(/href="([^"]*\.pdf)"/);
      const pdfUrl = pdfMatch?.[1] || (arxivId ? arxivId.replace('abs', 'pdf') + '.pdf' : undefined);

      if (title) {
        entries.push({
          title,
          authors,
          abstract: abstract.slice(0, 500) + (abstract.length > 500 ? '...' : ''),
          url: arxivId,
          source: 'arxiv',
          published_date: published,
          pdf_url: pdfUrl,
        });
      }
    }

    return entries;
  } catch (error) {
    logger.error('arXiv search failed', { error: (error as Error).message });
    return [];
  }
}

/**
 * 使用 Semantic Scholar API 搜索
 */
async function searchSemanticScholar(query: string, limit: number): Promise<PaperResult[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=${limit}&fields=title,authors,abstract,url,citationCount,publicationDate,openAccessPdf`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Semantic Scholar API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.data) {
      return data.data.map((paper: any) => ({
        title: paper.title || 'Unknown Title',
        authors: paper.authors?.map((a: any) => a.name) || [],
        abstract: paper.abstract?.slice(0, 500) || '',
        url: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
        source: 'semantic_scholar',
        published_date: paper.publicationDate,
        citations: paper.citationCount,
        pdf_url: paper.openAccessPdf?.url,
      }));
    }

    return [];
  } catch (error) {
    logger.error('Semantic Scholar search failed', { error: (error as Error).message });
    return [];
  }
}

/**
 * 格式化论文结果
 */
function formatPaperResults(papers: PaperResult[]): string {
  if (papers.length === 0) {
    return '未找到相关学术论文';
  }

  let output = `📚 学术搜索结果\n找到 ${papers.length} 篇相关论文\n\n`;

  papers.forEach((paper, index) => {
    output += `${'─'.repeat(50)}\n`;
    output += `**${index + 1}. ${paper.title}**\n`;

    if (paper.authors.length > 0) {
      const authorsStr = paper.authors.slice(0, 5).join(', ');
      if (paper.authors.length > 5) {
        output += `作者: ${authorsStr}, et al.\n`;
      } else {
        output += `作者: ${authorsStr}\n`;
      }
    }

    if (paper.published_date) {
      output += `发表日期: ${paper.published_date.slice(0, 10)}\n`;
    }

    if (paper.citations !== undefined) {
      output += `引用数: ${paper.citations}\n`;
    }

    output += `来源: ${paper.source}\n`;
    output += `链接: ${paper.url}\n`;

    if (paper.pdf_url) {
      output += `PDF: ${paper.pdf_url}\n`;
    }

    if (paper.abstract) {
      output += `\n摘要:\n${paper.abstract}\n`;
    }

    output += '\n';
  });

  return output;
}

export const academicSearchTool: Tool = {
  name: 'academic_search',
  description: `搜索学术论文和研究文献。

支持多个学术数据源：
- arXiv (默认): 预印本论文，涵盖物理、数学、计算机科学等
- Semantic Scholar: 广泛的学术数据库

**使用示例：**
\`\`\`
academic_search { "query": "transformer attention mechanism" }
academic_search { "query": "大语言模型", "limit": 10, "source": "arxiv" }
\`\`\`

**返回信息**：
- 论文标题
- 作者列表
- 发表日期
- 引用数（如有）
- 摘要
- PDF 链接（如有）`,
  requiresPermission: true,
  permissionLevel: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词或论文主题',
      },
      limit: {
        type: 'number',
        description: '返回结果数量（默认: 10，最大: 30）',
        default: 10,
      },
      source: {
        type: 'string',
        enum: ['arxiv', 'all'],
        description: '数据源: arxiv（仅 arXiv）或 all（多源）',
        default: 'all',
      },
      sort_by: {
        type: 'string',
        enum: ['relevance', 'date'],
        description: '排序方式: relevance（相关度）或 date（日期）',
        default: 'relevance',
      },
      year_from: {
        type: 'number',
        description: '起始年份（可选）',
      },
      year_to: {
        type: 'number',
        description: '结束年份（可选）',
      },
    },
    required: ['query'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      query,
      limit = 10,
      source = 'all',
      sort_by = 'relevance',
      year_from,
      year_to,
    } = params as unknown as AcademicSearchParams;

    const actualLimit = Math.min(Math.max(limit, 1), 30);

    context.emit?.('tool_output', {
      tool: 'academic_search',
      message: `📚 正在搜索学术论文: "${query}"`,
    });

    try {
      let allResults: PaperResult[] = [];

      // 根据来源选择搜索方式
      if (source === 'arxiv') {
        // 仅 arXiv
        allResults = await searchArxiv(query, actualLimit);
      } else {
        // 多源并行搜索
        const [arxivResults, ssResults, exaResults] = await Promise.all([
          searchArxiv(query, Math.ceil(actualLimit / 2)),
          searchSemanticScholar(query, Math.ceil(actualLimit / 2)),
          searchWithExaMCP(context, query, 5),
        ]);

        // 合并结果
        allResults = [...arxivResults, ...ssResults, ...exaResults];

        // 去重（基于标题相似度）
        const seen = new Set<string>();
        allResults = allResults.filter(paper => {
          const key = paper.title.toLowerCase().slice(0, 50);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      // 年份过滤
      if (year_from || year_to) {
        allResults = allResults.filter(paper => {
          if (!paper.published_date) return true;
          const year = parseInt(paper.published_date.slice(0, 4));
          if (year_from && year < year_from) return false;
          if (year_to && year > year_to) return false;
          return true;
        });
      }

      // 排序
      if (sort_by === 'date') {
        allResults.sort((a, b) => {
          const dateA = a.published_date || '0000';
          const dateB = b.published_date || '0000';
          return dateB.localeCompare(dateA);
        });
      }
      // relevance 排序：citations 优先
      else if (sort_by === 'relevance') {
        allResults.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0));
      }

      // 限制数量
      allResults = allResults.slice(0, actualLimit);

      const output = formatPaperResults(allResults);

      logger.info('Academic search completed', {
        query,
        resultsCount: allResults.length,
      });

      return {
        success: true,
        output,
        metadata: {
          query,
          resultsCount: allResults.length,
          sources: [...new Set(allResults.map(r => r.source))],
          papers: allResults,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Academic search failed', { error: message });
      return {
        success: false,
        error: `学术搜索失败: ${message}`,
      };
    }
  },
};
