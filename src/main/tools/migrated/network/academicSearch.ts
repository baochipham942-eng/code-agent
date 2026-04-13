// ============================================================================
// academic_search (P0-6.3 Batch 9 — network: native ToolModule rewrite)
//
// 学术搜索：arXiv API + Semantic Scholar API 多源并行。
// 注：legacy 有 Exa MCP 分支（依赖 context.mcpClient），native 无该依赖，已移除。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';

// 文件本地常量（Batch 9 保持内联，避免 shared/constants 膨胀）
const ARXIV_API = 'https://export.arxiv.org/api/query';
const SEMANTIC_SCHOLAR_API = 'https://api.semanticscholar.org/graph/v1/paper/search';
const MAX_LIMIT = 30;

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

const schema: ToolSchema = {
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
      },
      source: {
        type: 'string',
        enum: ['arxiv', 'all'],
        description: '数据源: arxiv（仅 arXiv）或 all（多源）',
      },
      sort_by: {
        type: 'string',
        enum: ['relevance', 'date'],
        description: '排序方式: relevance（相关度）或 date（日期）',
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
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};

async function searchArxiv(
  query: string,
  limit: number,
  ctx: ToolContext,
): Promise<PaperResult[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `${ARXIV_API}?search_query=all:${encodedQuery}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`arXiv API error: ${response.status}`);
    }

    const xmlText = await response.text();

    const entries: PaperResult[] = [];
    const entryMatches = xmlText.matchAll(/<entry>([\s\S]*?)<\/entry>/g);

    for (const match of entryMatches) {
      const entry = match[1];

      const title =
        entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, ' ') || '';
      const abstract =
        entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim().replace(/\s+/g, ' ') || '';
      const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || '';
      const arxivId = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || '';

      const authors: string[] = [];
      const authorMatches = entry.matchAll(
        /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g,
      );
      for (const authorMatch of authorMatches) {
        authors.push(authorMatch[1].trim());
      }

      const pdfMatch = entry.match(/href="([^"]*\.pdf)"/);
      const pdfUrl =
        pdfMatch?.[1] || (arxivId ? arxivId.replace('abs', 'pdf') + '.pdf' : undefined);

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
    ctx.logger.error('arXiv search failed', { error: (error as Error).message });
    return [];
  }
}

async function searchSemanticScholar(
  query: string,
  limit: number,
  ctx: ToolContext,
): Promise<PaperResult[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `${SEMANTIC_SCHOLAR_API}?query=${encodedQuery}&limit=${limit}&fields=title,authors,abstract,url,citationCount,publicationDate,openAccessPdf`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Semantic Scholar API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return data.data.map((paper: any) => ({
        title: paper.title || 'Unknown Title',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    ctx.logger.error('Semantic Scholar search failed', { error: (error as Error).message });
    return [];
  }
}

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

export async function executeAcademicSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const query = args.query;
  if (typeof query !== 'string' || query.length === 0) {
    return { ok: false, error: 'query is required and must be a string', code: 'INVALID_ARGS' };
  }

  const limit = (args.limit as number | undefined) ?? 10;
  const source = (args.source as 'arxiv' | 'all' | undefined) ?? 'all';
  const sortBy = (args.sort_by as 'relevance' | 'date' | undefined) ?? 'relevance';
  const yearFrom = args.year_from as number | undefined;
  const yearTo = args.year_to as number | undefined;

  if (!['arxiv', 'all'].includes(source)) {
    return { ok: false, error: `source must be 'arxiv' or 'all'`, code: 'INVALID_ARGS' };
  }
  if (!['relevance', 'date'].includes(sortBy)) {
    return { ok: false, error: `sort_by must be 'relevance' or 'date'`, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: 'academic_search' });

  const actualLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
  onProgress?.({ stage: 'running', detail: `搜索学术论文: "${query}"` });

  try {
    let allResults: PaperResult[] = [];

    if (source === 'arxiv') {
      allResults = await searchArxiv(query, actualLimit, ctx);
    } else {
      const [arxivResults, ssResults] = await Promise.all([
        searchArxiv(query, Math.ceil(actualLimit / 2), ctx),
        searchSemanticScholar(query, Math.ceil(actualLimit / 2), ctx),
      ]);

      allResults = [...arxivResults, ...ssResults];

      // 去重（基于标题相似度）
      const seen = new Set<string>();
      allResults = allResults.filter((paper) => {
        const key = paper.title.toLowerCase().slice(0, 50);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // 年份过滤
    if (yearFrom || yearTo) {
      allResults = allResults.filter((paper) => {
        if (!paper.published_date) return true;
        const year = parseInt(paper.published_date.slice(0, 4));
        if (yearFrom && year < yearFrom) return false;
        if (yearTo && year > yearTo) return false;
        return true;
      });
    }

    // 排序
    if (sortBy === 'date') {
      allResults.sort((a, b) => {
        const dateA = a.published_date || '0000';
        const dateB = b.published_date || '0000';
        return dateB.localeCompare(dateA);
      });
    } else if (sortBy === 'relevance') {
      allResults.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0));
    }

    allResults = allResults.slice(0, actualLimit);

    const output = formatPaperResults(allResults);

    ctx.logger.info('Academic search completed', { query, resultsCount: allResults.length });
    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output,
      meta: {
        query,
        resultsCount: allResults.length,
        sources: [...new Set(allResults.map((r) => r.source))],
        papers: allResults,
      },
    };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error('Academic search failed', { error: message });
    return { ok: false, error: `学术搜索失败: ${message}`, code: 'NETWORK_ERROR' };
  }
}

class AcademicSearchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeAcademicSearch(args, ctx, canUseTool, onProgress);
  }
}

export const academicSearchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new AcademicSearchHandler();
  },
};
