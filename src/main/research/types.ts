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
