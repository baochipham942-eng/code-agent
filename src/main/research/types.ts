// ============================================================================
// Deep Research Types - 深度研究模式类型定义
// ============================================================================

/**
 * 研究步骤类型
 */
export type ResearchStepType = 'research' | 'analysis' | 'processing';

/**
 * 单个研究步骤
 */
export interface ResearchStep {
  /** 步骤 ID */
  id: string;
  /** 步骤标题 */
  title: string;
  /** 详细描述 */
  description: string;
  /** 步骤类型 */
  stepType: ResearchStepType;
  /** 是否需要网络搜索（仅 research 类型有效）*/
  needSearch?: boolean;
  /** 搜索关键词（仅 research 类型有效）*/
  searchQueries?: string[];
  /** 执行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** 执行结果 */
  result?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 研究计划
 */
export interface ResearchPlan {
  /** 研究主题 */
  topic: string;
  /** 澄清后的主题（更精确）*/
  clarifiedTopic: string;
  /** 研究目标 */
  objectives: string[];
  /** 执行步骤 */
  steps: ResearchStep[];
  /** 预期产出 */
  expectedOutput: string;
  /** 计划创建时间 */
  createdAt: number;
}

/**
 * 报告风格
 */
export type ReportStyle =
  | 'academic'           // 学术论文风格
  | 'popular_science'    // 科普文章风格
  | 'news'              // 新闻报道风格
  | 'social_media'      // 社交媒体风格
  | 'strategic_investment' // 投资分析风格
  | 'default';          // 默认风格

/**
 * 研究报告
 */
export interface ResearchReport {
  /** 报告标题 */
  title: string;
  /** 报告风格 */
  style: ReportStyle;
  /** 摘要 */
  summary: string;
  /** 正文（Markdown）*/
  content: string;
  /** 参考来源 */
  sources: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
  /** 生成时间 */
  generatedAt: number;
}

/**
 * 深度研究配置
 */
export interface DeepResearchConfig {
  /** 最大研究步骤数 */
  maxSteps?: number;
  /** 每步最大搜索次数 */
  maxSearchPerStep?: number;
  /** 报告风格 */
  reportStyle?: ReportStyle;
  /** 是否强制网络搜索 */
  enforceWebSearch?: boolean;
  /** 语言偏好 */
  locale?: string;
  /** 模型提供商 */
  modelProvider?: string;
  /** 模型名称 */
  model?: string;
}

/**
 * 研究阶段
 */
export type ResearchPhase = 'planning' | 'researching' | 'reporting' | 'complete' | 'error';

/**
 * 研究进度事件数据
 */
export interface ResearchProgressData {
  phase: ResearchPhase;
  message: string;
  percent: number;
  currentStep?: {
    title: string;
    status: 'running' | 'completed' | 'failed';
  };
  error?: string;
}

/**
 * 运行选项（传递给 AgentLoop）
 */
export interface AgentRunOptions {
  mode: 'normal' | 'deep-research';
  reportStyle?: ReportStyle;
}

// ============================================================================
// 语义研究模式类型 - Semantic Research Mode Types
// ============================================================================

/**
 * 查询意图类型
 */
export type QueryIntent =
  | 'simple_lookup'       // 简单查询：是什么/定义
  | 'factual_question'    // 事实问题：何时/多少/在哪里
  | 'explanation'         // 解释说明：如何工作/原理
  | 'comparison'          // 对比研究：A vs B
  | 'analysis'            // 深度分析：分析/研究/调查
  | 'current_events'      // 时事新闻：最新/今年/近期
  | 'technical_deep_dive' // 技术深挖：架构/底层/源码
  | 'multi_faceted'       // 多面分析：涉及多个领域
  | 'code_task'           // 代码任务：编写/修复/重构
  | 'creative_task';      // 创意任务：设计/写作

/**
 * 研究深度等级
 */
export type ResearchDepth = 'quick' | 'standard' | 'deep';

/**
 * 数据源类型
 */
export type DataSourceType =
  | 'web_search'           // 通用网络搜索
  | 'news_search'          // 新闻搜索
  | 'academic_search'      // 学术搜索
  | 'code_search'          // 代码搜索（GitHub/StackOverflow）
  | 'documentation'        // 官方文档
  | 'mcp_deepwiki'         // DeepWiki MCP（GitHub 项目解读）
  | 'mcp_github'           // GitHub MCP
  | 'local_codebase'       // 本地代码库
  | 'memory_store';        // 记忆存储

/**
 * 意图分类结果
 */
export interface IntentClassification {
  /** 识别的意图类型 */
  intent: QueryIntent;
  /** 置信度（0-1） */
  confidence: number;
  /** 是否建议启用研究模式 */
  suggestsResearch: boolean;
  /** 建议的研究深度 */
  suggestedDepth: ResearchDepth;
  /** 建议的数据源 */
  suggestedSources: DataSourceType[];
  /** 分类推理过程 */
  reasoning: string;
}

/**
 * 自适应研究配置
 */
export interface AdaptiveResearchConfig {
  // 搜索参数
  /** 并行搜索数量 */
  parallelSearches: number;
  /** 每次搜索返回结果数 */
  resultsPerSearch: number;
  /** 每次搜索最大抓取页面数 */
  maxFetchesPerSearch: number;

  // 深度参数
  /** 最大迭代轮数 */
  maxIterations: number;
  /** 覆盖度阈值（达到时停止） */
  coverageThreshold: number;
  /** 新颖度阈值（低于时停止） */
  noveltyThreshold: number;

  // 预算限制
  /** 最大持续时间（毫秒） */
  maxDurationMs: number;
  /** 最大搜索调用次数 */
  maxSearchCalls: number;
  /** 最大页面抓取次数 */
  maxPageFetches: number;

  // 数据源
  /** 启用的数据源 */
  enabledSources: DataSourceType[];
  /** 报告风格 */
  reportStyle: ReportStyle;
}

/**
 * 研究状态（渐进式循环用）
 */
export interface ProgressiveResearchState {
  /** 研究主题 */
  topic: string;
  /** 当前迭代轮数 */
  iteration: number;

  // 收集的信息
  /** 来源结果 */
  sources: SourceResult[];
  /** 提取的事实 */
  facts: ExtractedFact[];
  /** 识别的信息空白 */
  gaps: IdentifiedGap[];

  // 覆盖度跟踪
  /** 各目标覆盖度（0-1） */
  objectivesCovered: Map<string, number>;
  /** 整体覆盖度 */
  overallCoverage: number;

  // 新颖度跟踪
  /** 上一轮新颖度 */
  lastIterationNovelty: number;
  /** 累计唯一信息量 */
  totalUniqueInfo: number;

  // 预算跟踪
  /** 已用搜索次数 */
  searchCallsUsed: number;
  /** 已用抓取次数 */
  pageFetchesUsed: number;
  /** 已用时间（毫秒） */
  timeElapsedMs: number;
  /** 开始时间 */
  startTime: number;
}

/**
 * 来源结果
 */
export interface SourceResult {
  /** 来源 URL */
  url: string;
  /** 来源标题 */
  title: string;
  /** 来源类型 */
  sourceType: DataSourceType;
  /** 内容摘要 */
  content: string;
  /** 抓取时间 */
  fetchedAt: number;
  /** 相关度评分 */
  relevanceScore?: number;
}

/**
 * 提取的事实
 */
export interface ExtractedFact {
  /** 事实内容 */
  content: string;
  /** 来源 URL */
  sourceUrl: string;
  /** 相关目标 */
  relatedObjective?: string;
  /** 置信度 */
  confidence: number;
}

/**
 * 识别的信息空白
 */
export interface IdentifiedGap {
  /** 空白描述 */
  description: string;
  /** 相关目标 */
  relatedObjective?: string;
  /** 建议的搜索查询 */
  suggestedQueries: string[];
  /** 优先级（1-5） */
  priority: number;
}

/**
 * 停止原因类型
 */
export type StoppingReasonType =
  | 'coverage'          // 覆盖度达标
  | 'novelty_exhausted' // 新颖度枯竭
  | 'budget_search'     // 搜索次数达限
  | 'budget_fetch'      // 抓取次数达限
  | 'budget_time'       // 时间达限
  | 'max_iterations'    // 迭代次数达限
  | 'user_stopped';     // 用户停止

/**
 * 停止条件分析结果
 */
export interface StoppingAnalysis {
  /** 是否应该停止 */
  shouldStop: boolean;
  /** 停止原因 */
  reason: StoppingReasonType | null;
  /** 详细信息 */
  details: string;
  /** 是否可以继续（用户请求时） */
  canContinue: boolean;
}

/**
 * 研究进度事件（增强版）
 */
export interface EnhancedResearchProgress extends ResearchProgressData {
  /** 触发方式 */
  triggeredBy: 'semantic' | 'manual';
  /** 当前迭代 */
  currentIteration: number;
  /** 最大迭代 */
  maxIterations: number;
  /** 覆盖度 */
  coverage: number;
  /** 使用的数据源 */
  activeSources: DataSourceType[];
  /** 是否可以深入 */
  canDeepen: boolean;
}

/**
 * 用户研究设置
 */
export interface ResearchUserSettings {
  /** 启用语义检测 */
  autoDetect: boolean;
  /** 研究前确认 */
  confirmBeforeStart: boolean;
  /** 偏好的数据源 */
  preferredSources: DataSourceType[];
  /** 默认深度 */
  defaultDepth: ResearchDepth;
  /** 最大持续时间（分钟） */
  maxDurationMinutes: number;
  /** 默认报告风格 */
  reportStyle: ReportStyle;
}
