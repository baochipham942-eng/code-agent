// ============================================================================
// Intent Classifier - 意图分类器
// 通过语义分析判断用户查询是否需要深度研究
// ============================================================================

import type { ModelRouter } from '../model/modelRouter';
import type {
  QueryIntent,
  IntentClassification,
  ResearchDepth,
  DataSourceType,
} from './types';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('IntentClassifier');

// ----------------------------------------------------------------------------
// 明确指代检测
// ----------------------------------------------------------------------------

/**
 * 检测消息中是否有明确的指代内容
 * 返回提取的明确内容和类型
 */
interface ExplicitReference {
  type: 'quoted_text' | 'book_title' | 'url' | 'code_block' | 'file_path' | 'specific_name';
  content: string;
}

/**
 * 从消息中提取明确指代
 */
function extractExplicitReferences(message: string): ExplicitReference[] {
  const references: ExplicitReference[] = [];

  // 中文引号内容："xxx" 或 'xxx'
  const chineseQuotes = message.match(/[""]([^""]+)[""]|['']([^'']+)['']/g);
  if (chineseQuotes) {
    chineseQuotes.forEach(q => {
      const content = q.replace(/["'""'']/g, '').trim();
      if (content.length > 0) {
        references.push({ type: 'quoted_text', content });
      }
    });
  }

  // 英文引号内容
  const englishQuotes = message.match(/"([^"]+)"|'([^']+)'/g);
  if (englishQuotes) {
    englishQuotes.forEach(q => {
      const content = q.replace(/["']/g, '').trim();
      if (content.length > 0 && !references.some(r => r.content === content)) {
        references.push({ type: 'quoted_text', content });
      }
    });
  }

  // 书名号内容：《xxx》
  const bookTitles = message.match(/《([^》]+)》/g);
  if (bookTitles) {
    bookTitles.forEach(t => {
      const content = t.replace(/[《》]/g, '').trim();
      if (content.length > 0) {
        references.push({ type: 'book_title', content });
      }
    });
  }

  // URL
  const urls = message.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi);
  if (urls) {
    urls.forEach(url => {
      references.push({ type: 'url', content: url });
    });
  }

  // 文件路径 (Unix/Windows)
  const filePaths = message.match(/(?:\/[\w\-\.]+)+\.\w+|[A-Z]:\\(?:[\w\-\.]+\\)*[\w\-\.]+\.\w+/g);
  if (filePaths) {
    filePaths.forEach(path => {
      references.push({ type: 'file_path', content: path });
    });
  }

  // 代码块 `xxx`
  const codeBlocks = message.match(/`([^`]+)`/g);
  if (codeBlocks) {
    codeBlocks.forEach(block => {
      const content = block.replace(/`/g, '').trim();
      if (content.length > 0) {
        references.push({ type: 'code_block', content });
      }
    });
  }

  // 具体名称（如项目名、库名等）- 以大写开头或全大写
  const specificNames = message.match(/\b[A-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*\b|\b[A-Z]{2,}[a-zA-Z0-9]*\b/g);
  if (specificNames) {
    specificNames.forEach(name => {
      // 排除常见词
      const commonWords = ['I', 'A', 'The', 'This', 'That', 'What', 'How', 'Why', 'When', 'Where', 'API', 'URL', 'HTTP', 'HTTPS'];
      if (!commonWords.includes(name) && name.length > 1) {
        references.push({ type: 'specific_name', content: name });
      }
    });
  }

  return references;
}

/**
 * 检测是否为模糊指代（需要询问用户）
 */
function detectAmbiguousReference(message: string, hasExplicitRefs: boolean): {
  isAmbiguous: boolean;
  reason?: string;
} {
  // 如果有明确引用，则不是模糊指代
  if (hasExplicitRefs) {
    return { isAmbiguous: false };
  }

  // 模糊指代词检测
  const ambiguousPatterns = [
    { pattern: /(?:这个|那个|它|这|那)(?:东西|玩意|项目|文件|代码|问题)?(?:是什么|怎么|如何)?/i, reason: '指示代词"这/那"无明确指向' },
    { pattern: /(?:上面|前面|刚才|之前)(?:提到|说|讲)的/i, reason: '引用上文内容但无具体指明' },
    { pattern: /^(?:帮我|请|麻烦).{0,10}(?:搜索?|查找?|找)一下$/i, reason: '请求过于笼统' },
    { pattern: /^(?:搜索?|查找?|找).*(?:相关|有关).*$/i, reason: '搜索目标不明确' },
  ];

  for (const { pattern, reason } of ambiguousPatterns) {
    if (pattern.test(message)) {
      // 二次检查：如果消息中有其他具体内容，则不算模糊
      const hasConcreteContent = message.length > 20 && !/^[这那它]/.test(message);
      if (!hasConcreteContent) {
        return { isAmbiguous: true, reason };
      }
    }
  }

  return { isAmbiguous: false };
}

// ----------------------------------------------------------------------------
// 规则匹配模式
// ----------------------------------------------------------------------------

interface ClassificationRule {
  pattern: RegExp;
  intent: QueryIntent;
  confidence: number;
  depth: ResearchDepth;
  sources: DataSourceType[];
}

/**
 * 高置信度规则（快速路径）
 */
const CLASSIFICATION_RULES: ClassificationRule[] = [
  // 深度研究指示词（高优先级）
  {
    pattern: /(?:深度|深入|全面|系统|综合)(?:研究|分析|调查|探讨)|research|investigate|in-depth|comprehensive/i,
    intent: 'analysis',
    confidence: 0.95,
    depth: 'deep',
    sources: ['web_search', 'academic_search', 'documentation'],
  },

  // 对比研究
  {
    pattern: /(?:对比|比较|versus|vs\.?|相比|优劣|区别|差异).*(?:分析|研究)?|compare|comparison/i,
    intent: 'comparison',
    confidence: 0.9,
    depth: 'standard',
    sources: ['web_search', 'documentation', 'code_search'],
  },

  // 时事新闻
  {
    pattern: /(?:最新|最近|近期|今年|今天|昨天|本周|本月|2024|2025|2026).*(?:新闻|动态|进展|消息|发布)|latest|recent|news|current/i,
    intent: 'current_events',
    confidence: 0.85,
    depth: 'quick',
    sources: ['web_search', 'news_search'],
  },

  // 技术深挖
  {
    pattern: /(?:底层|架构|原理|源码|实现|机制|内部).*(?:分析|解析|详解)|architecture|implementation|internals|how.*(?:work|implement)/i,
    intent: 'technical_deep_dive',
    confidence: 0.85,
    depth: 'deep',
    sources: ['documentation', 'mcp_deepwiki', 'code_search', 'web_search'],
  },

  // 代码任务（跳过研究）
  {
    pattern: /(?:写|编写|创建|生成|实现|开发|修复|修改|重构|优化).*(?:代码|函数|方法|类|组件|模块|程序|脚本)|write|create|implement|fix|refactor|debug.*code/i,
    intent: 'code_task',
    confidence: 0.9,
    depth: 'quick',
    sources: [],
  },

  // 文件操作任务（跳过研究）- 本地文件系统操作
  {
    pattern: /(?:统计|计数|列出|显示|查找|搜索|打开|删除|移动|复制|重命名|整理).*(?:文件|文件夹|目录|图片|照片|截图|视频|音频|文档)|(?:有多少|多少个).*(?:文件|图片|照片)|count|list|find|open|delete|move|copy|rename.*(?:file|folder|directory|image|photo|screenshot)/i,
    intent: 'code_task',
    confidence: 0.95,
    depth: 'quick',
    sources: [],
  },

  // 创意任务（跳过研究）
  {
    pattern: /(?:设计|写作|起草|创作|画|生成).*(?:文案|故事|文章|邮件|PPT|报告|UI|界面)|design|draft|compose/i,
    intent: 'creative_task',
    confidence: 0.85,
    depth: 'quick',
    sources: [],
  },

  // 解释说明
  {
    pattern: /(?:如何|怎么|怎样|为什么|什么是|介绍|解释|说明).*(?:工作|运行|原理|概念)|how\s+(?:does|do|to)|what\s+is|explain|introduction/i,
    intent: 'explanation',
    confidence: 0.75,
    depth: 'standard',
    sources: ['web_search', 'documentation'],
  },

  // 简单查询
  {
    pattern: /^(?:什么是|谁是|何时|哪里|多少|是不是).*\?*$|^(?:what|who|when|where|how many|is it)\s/i,
    intent: 'simple_lookup',
    confidence: 0.7,
    depth: 'quick',
    sources: ['web_search'],
  },

  // 事实问题
  {
    pattern: /(?:什么时候|多少|几个|哪些|哪个|是否|有没有)|when\s+(?:did|was|is)|how\s+(?:many|much)/i,
    intent: 'factual_question',
    confidence: 0.7,
    depth: 'quick',
    sources: ['web_search'],
  },
];

/**
 * 不需要研究的意图类型
 */
const NON_RESEARCH_INTENTS: QueryIntent[] = [
  'code_task',
  'creative_task',
  'simple_lookup',
];

/**
 * 各意图对应的默认深度
 */
const INTENT_DEFAULT_DEPTH: Record<QueryIntent, ResearchDepth> = {
  simple_lookup: 'quick',
  factual_question: 'quick',
  explanation: 'standard',
  comparison: 'standard',
  analysis: 'deep',
  current_events: 'quick',
  technical_deep_dive: 'deep',
  multi_faceted: 'deep',
  code_task: 'quick',
  creative_task: 'quick',
};

/**
 * 各意图对应的默认数据源
 */
const INTENT_DEFAULT_SOURCES: Record<QueryIntent, DataSourceType[]> = {
  simple_lookup: ['web_search'],
  factual_question: ['web_search'],
  explanation: ['web_search', 'documentation'],
  comparison: ['web_search', 'documentation', 'code_search'],
  analysis: ['web_search', 'academic_search', 'documentation'],
  current_events: ['web_search', 'news_search'],
  technical_deep_dive: ['documentation', 'mcp_deepwiki', 'code_search', 'web_search'],
  multi_faceted: ['web_search', 'academic_search', 'documentation', 'news_search'],
  code_task: [],
  creative_task: [],
};

// ----------------------------------------------------------------------------
// Intent Classifier
// ----------------------------------------------------------------------------

/**
 * 意图分类器配置
 */
export interface IntentClassifierConfig {
  /** LLM 回退阈值 */
  llmFallbackThreshold?: number;
  /** LLM 最大 token */
  maxLLMTokens?: number;
  /** 启用先执行后反馈策略（减少询问） */
  executeFirstStrategy?: boolean;
}

/**
 * 意图分类器
 *
 * 使用混合策略进行意图分类：
 * 1. 明确指代检测（快速路径）
 * 2. 规则匹配快速路径（高置信度）
 * 3. LLM 分类回退（低置信度时）
 *
 * 优化策略：
 * - 有明确引号/书名号/URL 等内容时直接执行，不询问
 * - 只有真正模糊的指代（如无上下文的"这个"）才询问
 */
export class IntentClassifier {
  private modelRouter: ModelRouter;
  private llmFallbackThreshold: number;
  private maxLLMTokens: number;
  private executeFirstStrategy: boolean;

  constructor(
    modelRouter: ModelRouter,
    options: IntentClassifierConfig = {}
  ) {
    this.modelRouter = modelRouter;
    this.llmFallbackThreshold = options.llmFallbackThreshold ?? 0.7;
    this.maxLLMTokens = options.maxLLMTokens ?? 150;
    this.executeFirstStrategy = options.executeFirstStrategy ?? true;
  }

  /**
   * 分类用户查询
   *
   * @param userMessage - 用户消息
   * @param conversationContext - 可选的对话上下文（用于理解指代）
   * @returns 分类结果
   */
  async classify(
    userMessage: string,
    conversationContext?: string[]
  ): Promise<IntentClassification> {
    const trimmedMessage = userMessage.trim();

    // 空消息处理
    if (!trimmedMessage) {
      return this.createClassification('simple_lookup', 0.5, '空消息');
    }

    // 0. 明确指代检测（优先级最高）
    const explicitRefs = extractExplicitReferences(trimmedMessage);
    const hasExplicitRefs = explicitRefs.length > 0;
    const ambiguityCheck = detectAmbiguousReference(trimmedMessage, hasExplicitRefs);

    logger.debug('Reference analysis:', {
      explicitRefs: explicitRefs.map(r => r.type),
      isAmbiguous: ambiguityCheck.isAmbiguous,
    });

    // 如果有明确引用，提升置信度并跳过询问
    if (hasExplicitRefs && this.executeFirstStrategy) {
      // 检测引用类型来决定意图
      const refTypes = explicitRefs.map(r => r.type);

      // URL -> 可能是网页抓取
      if (refTypes.includes('url')) {
        return {
          intent: 'analysis',
          confidence: 0.9,
          suggestsResearch: true,
          suggestedDepth: 'standard',
          suggestedSources: ['web_search'],
          reasoning: `检测到明确 URL: ${explicitRefs.find(r => r.type === 'url')?.content}`,
          explicitReferences: explicitRefs,
          requiresClarification: false,
        };
      }

      // 书名号 -> 可能是学术搜索
      if (refTypes.includes('book_title')) {
        return {
          intent: 'analysis',
          confidence: 0.9,
          suggestsResearch: true,
          suggestedDepth: 'standard',
          suggestedSources: ['academic_search', 'web_search'],
          reasoning: `检测到书名/论文名: ${explicitRefs.find(r => r.type === 'book_title')?.content}`,
          explicitReferences: explicitRefs,
          requiresClarification: false,
        };
      }

      // 文件路径 -> 本地操作
      if (refTypes.includes('file_path')) {
        return {
          intent: 'code_task',
          confidence: 0.95,
          suggestsResearch: false,
          suggestedDepth: 'quick',
          suggestedSources: [],
          reasoning: `检测到文件路径: ${explicitRefs.find(r => r.type === 'file_path')?.content}`,
          explicitReferences: explicitRefs,
          requiresClarification: false,
        };
      }
    }

    // 如果是模糊指代且没有上下文，标记需要澄清（但不一定要询问）
    if (ambiguityCheck.isAmbiguous && !conversationContext?.length) {
      logger.debug('Ambiguous reference detected:', ambiguityCheck.reason);
      // 只有在非 executeFirstStrategy 模式下才强制要求澄清
      if (!this.executeFirstStrategy) {
        return {
          ...this.createClassification('simple_lookup', 0.4, ambiguityCheck.reason || '需要澄清'),
          requiresClarification: true,
          clarificationReason: ambiguityCheck.reason,
        };
      }
    }

    // 1. 规则匹配快速路径
    const ruleResult = this.classifyByRules(trimmedMessage);
    if (ruleResult && ruleResult.confidence >= this.llmFallbackThreshold) {
      logger.debug('Intent classified by rules:', {
        intent: ruleResult.intent,
        confidence: ruleResult.confidence,
      });
      // 附加明确引用信息
      return {
        ...ruleResult,
        explicitReferences: explicitRefs,
        requiresClarification: false,
      };
    }

    // 2. 消息长度和结构分析
    const structureAnalysis = this.analyzeMessageStructure(trimmedMessage);
    if (structureAnalysis.confidence >= this.llmFallbackThreshold) {
      logger.debug('Intent classified by structure:', {
        intent: structureAnalysis.intent,
        confidence: structureAnalysis.confidence,
      });
      return {
        ...structureAnalysis,
        explicitReferences: explicitRefs,
        requiresClarification: false,
      };
    }

    // 3. LLM 分类回退
    try {
      const llmResult = await this.classifyByLLM(trimmedMessage);
      logger.debug('Intent classified by LLM:', {
        intent: llmResult.intent,
        confidence: llmResult.confidence,
      });
      return {
        ...llmResult,
        explicitReferences: explicitRefs,
        requiresClarification: false,
      };
    } catch (error) {
      logger.warn('LLM classification failed, using fallback:', error);
      // 回退到规则结果或默认
      const fallback = ruleResult ?? this.createClassification('explanation', 0.5, 'LLM 分类失败，使用默认');
      return {
        ...fallback,
        explicitReferences: explicitRefs,
        requiresClarification: ambiguityCheck.isAmbiguous,
      };
    }
  }

  /**
   * 检查消息是否需要用户澄清
   */
  checkRequiresClarification(userMessage: string, hasContext: boolean = false): {
    requires: boolean;
    reason?: string;
    explicitRefs: ExplicitReference[];
  } {
    const explicitRefs = extractExplicitReferences(userMessage);
    const ambiguityCheck = detectAmbiguousReference(userMessage, explicitRefs.length > 0);

    if (explicitRefs.length > 0) {
      return { requires: false, explicitRefs };
    }

    if (ambiguityCheck.isAmbiguous && !hasContext) {
      return {
        requires: !this.executeFirstStrategy,
        reason: ambiguityCheck.reason,
        explicitRefs: [],
      };
    }

    return { requires: false, explicitRefs };
  }

  /**
   * 规则匹配分类
   */
  private classifyByRules(message: string): IntentClassification | null {
    for (const rule of CLASSIFICATION_RULES) {
      if (rule.pattern.test(message)) {
        return {
          intent: rule.intent,
          confidence: rule.confidence,
          suggestsResearch: !NON_RESEARCH_INTENTS.includes(rule.intent),
          suggestedDepth: rule.depth,
          suggestedSources: rule.sources,
          reasoning: `匹配规则: ${rule.pattern.source.slice(0, 50)}...`,
        };
      }
    }
    return null;
  }

  /**
   * 消息结构分析
   */
  private analyzeMessageStructure(message: string): IntentClassification {
    const length = message.length;
    const hasMultipleQuestions = (message.match(/[？?]/g) || []).length > 1;
    const hasListMarkers = /[•\-\d+\.\)]\s/.test(message);
    const hasMultipleParagraphs = message.includes('\n\n');

    // 多问题或列表 -> 多面分析
    if (hasMultipleQuestions || (hasListMarkers && length > 100)) {
      return {
        intent: 'multi_faceted',
        confidence: 0.75,
        suggestsResearch: true,
        suggestedDepth: 'deep',
        suggestedSources: INTENT_DEFAULT_SOURCES.multi_faceted,
        reasoning: '消息包含多个问题或列表，判断为多面分析',
      };
    }

    // 长消息 -> 可能需要深入研究
    if (length > 200) {
      return {
        intent: 'analysis',
        confidence: 0.65,
        suggestsResearch: true,
        suggestedDepth: 'standard',
        suggestedSources: INTENT_DEFAULT_SOURCES.analysis,
        reasoning: '长消息（>200字），可能需要深入研究',
      };
    }

    // 短消息 -> 简单查询
    if (length < 30) {
      return {
        intent: 'simple_lookup',
        confidence: 0.6,
        suggestsResearch: false,
        suggestedDepth: 'quick',
        suggestedSources: INTENT_DEFAULT_SOURCES.simple_lookup,
        reasoning: '短消息（<30字），判断为简单查询',
      };
    }

    // 默认：解释说明
    return {
      intent: 'explanation',
      confidence: 0.5,
      suggestsResearch: false,
      suggestedDepth: 'standard',
      suggestedSources: INTENT_DEFAULT_SOURCES.explanation,
      reasoning: '无明确特征，默认为解释说明',
    };
  }

  /**
   * LLM 分类
   */
  private async classifyByLLM(message: string): Promise<IntentClassification> {
    const prompt = `分析以下用户查询，判断其意图类型和是否需要深度研究。

用户查询: "${message.slice(0, 500)}"

可选意图类型:
- simple_lookup: 简单查询（定义、是什么）
- factual_question: 事实问题（何时、多少、哪里）
- explanation: 解释说明（如何工作、原理）
- comparison: 对比研究（A vs B）
- analysis: 深度分析（研究、调查）
- current_events: 时事新闻（最新、近期）
- technical_deep_dive: 技术深挖（架构、源码）
- multi_faceted: 多面分析（涉及多领域）
- code_task: 代码任务（编写、修复）
- creative_task: 创意任务（设计、写作）

请用以下 JSON 格式回复：
{"intent": "意图类型", "confidence": 0.8, "needs_research": true, "depth": "quick|standard|deep", "reasoning": "简短理由"}`;

    const response = await this.modelRouter.chat({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: this.maxLLMTokens,
    });

    try {
      // 提取 JSON
      const jsonMatch = response.content?.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        intent: QueryIntent;
        confidence: number;
        needs_research: boolean;
        depth: ResearchDepth;
        reasoning: string;
      };

      // 验证意图类型
      const validIntents: QueryIntent[] = [
        'simple_lookup', 'factual_question', 'explanation', 'comparison',
        'analysis', 'current_events', 'technical_deep_dive', 'multi_faceted',
        'code_task', 'creative_task',
      ];

      const intent = validIntents.includes(parsed.intent)
        ? parsed.intent
        : 'explanation';

      return {
        intent,
        confidence: Math.min(Math.max(parsed.confidence || 0.7, 0), 1),
        suggestsResearch: parsed.needs_research ?? !NON_RESEARCH_INTENTS.includes(intent),
        suggestedDepth: parsed.depth || INTENT_DEFAULT_DEPTH[intent],
        suggestedSources: INTENT_DEFAULT_SOURCES[intent],
        reasoning: parsed.reasoning || 'LLM 分类',
      };
    } catch (parseError) {
      logger.warn('Failed to parse LLM classification response:', parseError);
      return this.createClassification('explanation', 0.6, 'LLM 响应解析失败');
    }
  }

  /**
   * 创建分类结果
   */
  private createClassification(
    intent: QueryIntent,
    confidence: number,
    reasoning: string
  ): IntentClassification {
    return {
      intent,
      confidence,
      suggestsResearch: !NON_RESEARCH_INTENTS.includes(intent),
      suggestedDepth: INTENT_DEFAULT_DEPTH[intent],
      suggestedSources: INTENT_DEFAULT_SOURCES[intent],
      reasoning,
    };
  }

  /**
   * 快速检查是否可能需要研究（不调用 LLM）
   *
   * 用于性能敏感场景，仅使用规则匹配
   */
  quickCheckResearchNeeded(userMessage: string): boolean {
    const trimmedMessage = userMessage.trim();
    if (!trimmedMessage) return false;

    // 检查研究指示词
    const researchKeywords = /(?:研究|分析|调查|对比|比较|深入|全面|最新|进展|架构|原理|机制)|research|analyze|compare|investigate|latest|architecture/i;
    if (researchKeywords.test(trimmedMessage)) {
      return true;
    }

    // 检查代码任务（排除）
    const codeKeywords = /(?:写|编写|创建|生成|修复|修改|重构).*(?:代码|函数|程序)|write.*code|create.*function|fix.*bug/i;
    if (codeKeywords.test(trimmedMessage)) {
      return false;
    }

    // 长消息可能需要研究
    if (trimmedMessage.length > 150) {
      return true;
    }

    return false;
  }
}
