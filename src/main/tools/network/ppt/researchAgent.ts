// ============================================================================
// Research Agent - 深度搜索 → 结构化数据
// ============================================================================
// 输入：TopicBrief（主题、受众、风格、关键词）
// 输出：ResearchContext（事实、统计、引言、来源）
// 流程：web_search 并行搜索 → web_fetch 提取 → LLM 结构化
// ============================================================================

import { createLogger } from '../../../services/infra/logger';
import type { TopicBrief, ResearchContext, ResearchFact } from './types';
import { RESEARCH_MAX_QUERIES, RESEARCH_MAX_URLS, RESEARCH_MAX_FETCH, RESEARCH_MAX_CONTENT_CHARS, DEFAULT_SLIDE_COUNT } from './constants';

const logger = createLogger('ResearchAgent');

// ============================================================================
// Query Generation
// ============================================================================

/**
 * 根据 TopicBrief 生成 3-5 组搜索关键词
 */
export function generateResearchQueries(brief: TopicBrief): string[] {
  const { topic, audience, keywords } = brief;
  const year = new Date().getFullYear();
  const keywordStr = keywords.slice(0, 3).join(' ');

  const queries: string[] = [
    `${topic} ${year} 最新数据 统计 市场规模`,
    `${topic} ${keywordStr} 核心趋势 分析报告`,
    `${topic} 案例 应用场景 企业实践 ${year}`,
  ];

  // 根据受众添加特定查询
  switch (audience) {
    case 'investor':
      queries.push(`${topic} 市场规模 融资 投资回报 ROI ${year}`);
      break;
    case 'technical':
      queries.push(`${topic} 技术架构 实现原理 性能对比 benchmark`);
      break;
    case 'management':
      queries.push(`${topic} 企业转型 降本增效 竞争力 战略`);
      break;
    default:
      queries.push(`${topic} 入门指南 核心概念 ${year}`);
  }

  // 添加关键词组合查询
  if (keywords.length >= 2) {
    queries.push(`${keywords[0]} ${keywords[1]} ${year} 报告 数据`);
  }

  return queries.slice(0, RESEARCH_MAX_QUERIES);
}

// ============================================================================
// Research Execution
// ============================================================================

/**
 * 执行深度搜索，返回结构化研究上下文
 *
 * @param brief - 主题简报
 * @param modelCallback - 模型回调（用于 LLM 提取结构化数据）
 * @param webSearch - web_search 工具函数（可选，由调用方注入）
 * @param webFetch - web_fetch 工具函数（可选，由调用方注入）
 */
export async function executeResearch(
  brief: TopicBrief,
  modelCallback: (prompt: string) => Promise<string>,
  webSearch?: (query: string) => Promise<string>,
  webFetch?: (url: string, prompt: string) => Promise<string>,
): Promise<ResearchContext> {
  const queries = generateResearchQueries(brief);
  logger.debug(`Research queries: ${queries.join(' | ')}`);

  // Phase 1: 并行搜索
  const searchResults: string[] = [];
  if (webSearch) {
    const searchPromises = queries.map(async (q) => {
      try {
        return await webSearch(q);
      } catch (err: any) {
        logger.warn(`Search failed for "${q}": ${err.message}`);
        return '';
      }
    });
    const results = await Promise.all(searchPromises);
    searchResults.push(...results.filter(r => r.length > 0));
  }

  // Phase 2: 提取 Top 来源 URL 并 fetch 详情
  const urls = extractUrls(searchResults.join('\n')).slice(0, RESEARCH_MAX_URLS);
  const fetchedContent: string[] = [];
  if (webFetch && urls.length > 0) {
    const fetchPromises = urls.slice(0, RESEARCH_MAX_FETCH).map(async (url) => {
      try {
        return await webFetch(url, `提取关于"${brief.topic}"的关键事实、统计数据和引言`);
      } catch (err: any) {
        logger.warn(`Fetch failed for "${url}": ${err.message}`);
        return '';
      }
    });
    const results = await Promise.all(fetchPromises);
    fetchedContent.push(...results.filter(r => r.length > 0));
  }

  // Phase 3: LLM 结构化提取
  const allContent = [...searchResults, ...fetchedContent].join('\n\n---\n\n');
  if (allContent.trim().length === 0) {
    logger.warn('No search results, returning empty research context');
    return createEmptyContext();
  }

  return extractStructuredData(brief, allContent, modelCallback);
}

/**
 * 从搜索/抓取内容中用 LLM 提取结构化数据
 */
async function extractStructuredData(
  brief: TopicBrief,
  rawContent: string,
  modelCallback: (prompt: string) => Promise<string>,
): Promise<ResearchContext> {
  // 截取避免超出上下文窗口
  const trimmedContent = rawContent.slice(0, RESEARCH_MAX_CONTENT_CHARS);

  const prompt = `你是数据研究员。从以下搜索结果中，针对主题"${brief.topic}"提取结构化数据。

搜索结果：
${trimmedContent}

请返回 JSON 对象，格式如下：
{
  "facts": [{"content": "具体事实描述", "source": "URL", "type": "fact|statistic|quote|case"}],
  "statistics": [{"label": "指标名", "value": "具体数字", "source": "URL", "description": "说明"}],
  "quotes": [{"text": "引言原文", "attribution": "出处人/机构", "source": "URL"}],
  "sources": [{"url": "URL", "title": "来源标题", "relevance": 0.8}]
}

要求：
1. statistics.value 必须是具体数字（如"$680亿"、"47%"），不要模糊描述
2. 每个 fact 必须有 source URL（如果搜索结果中无 URL，用 "search" 标记）
3. 至少提取 5 个 facts、3 个 statistics
4. 只返回 JSON，不要其他文字`;

  try {
    const response = await modelCallback(prompt);
    const parsed = parseJsonResponse(response);
    if (parsed) {
      logger.debug(`Extracted: ${parsed.facts?.length || 0} facts, ${parsed.statistics?.length || 0} stats`);
      return normalizeResearchContext(parsed);
    }
  } catch (err: any) {
    logger.warn(`LLM extraction failed: ${err.message}`);
  }

  return createEmptyContext();
}

// ============================================================================
// Topic Brief Extraction
// ============================================================================

/**
 * 从用户输入中提取 TopicBrief（轻量级，不需要模型调用）
 */
export function parseTopicBrief(
  topic: string,
  slidesCount: number = DEFAULT_SLIDE_COUNT,
  style?: string,
): TopicBrief {
  // 推断受众
  let audience: TopicBrief['audience'] = 'general';
  if (/投资|融资|ROI|估值|商业计划/i.test(topic)) audience = 'investor';
  else if (/技术|架构|API|算法|开发|SDK/i.test(topic)) audience = 'technical';
  else if (/管理|战略|运营|团队|OKR|KPI/i.test(topic)) audience = 'management';

  // 推断风格
  let inferredStyle: TopicBrief['style'] = 'business';
  if (/科技|AI|技术|开发|编程/i.test(topic)) inferredStyle = 'tech';
  else if (/论文|研究|学术|实验/i.test(topic)) inferredStyle = 'academic';
  else if (/设计|创意|品牌|UX/i.test(topic)) inferredStyle = 'creative';
  else if (/营销|推广|增长|流量/i.test(topic)) inferredStyle = 'marketing';

  // 提取关键词
  const keywords = extractKeywords(topic);

  return {
    topic,
    audience,
    style: (style as TopicBrief['style']) || inferredStyle,
    slideCount: slidesCount,
    keywords,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function extractKeywords(text: string): string[] {
  // 移除常见停用词，提取关键词
  const stopWords = /^(的|了|在|是|我|有|和|就|不|人|都|一|个|上|也|到|这|他|中|对|要|与|及|或|等|从|做|被|将|让|向|把|给|用|以|为|去|很|还|能|会|来|多|那|些|着|下|可|你|她|它|们|之|其|所|此|但|而|于|如|更|又|没|已|被|过|被|并|又|已|才|只|却|再|所以|因为|虽然|但是)$/;
  const words = text
    .replace(/[，。！？、；：""''（）【】《》]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !stopWords.test(w));

  return [...new Set(words)].slice(0, 8);
}

function extractUrls(text: string): string[] {
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/g;
  const matches = text.match(urlPattern) || [];
  return [...new Set(matches)];
}

function parseJsonResponse(text: string): any {
  // 直接解析
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // 提取 ```json ... ``` 块
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch { /* continue */ }
  }

  // 提取 { ... } 块
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* continue */ }
  }

  return null;
}

function normalizeResearchContext(raw: any): ResearchContext {
  return {
    facts: Array.isArray(raw.facts) ? raw.facts.map((f: any) => ({
      content: String(f.content || ''),
      source: String(f.source || 'search'),
      type: ['fact', 'statistic', 'quote', 'case'].includes(f.type) ? f.type : 'fact',
    })) : [],
    statistics: Array.isArray(raw.statistics) ? raw.statistics.map((s: any) => ({
      label: String(s.label || ''),
      value: String(s.value || ''),
      source: String(s.source || 'search'),
      description: s.description ? String(s.description) : undefined,
    })) : [],
    quotes: Array.isArray(raw.quotes) ? raw.quotes.map((q: any) => ({
      text: String(q.text || ''),
      attribution: String(q.attribution || ''),
      source: String(q.source || 'search'),
    })) : [],
    sources: Array.isArray(raw.sources) ? raw.sources.map((s: any) => ({
      url: String(s.url || ''),
      title: String(s.title || ''),
      relevance: typeof s.relevance === 'number' ? s.relevance : 0.5,
    })) : [],
  };
}

function createEmptyContext(): ResearchContext {
  return { facts: [], statistics: [], quotes: [], sources: [] };
}
