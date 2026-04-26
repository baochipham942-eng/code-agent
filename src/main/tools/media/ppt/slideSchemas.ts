// ============================================================================
// Structured Slide Schema - Per-Layout Content Contracts
// ============================================================================
// 每种布局定义内容契约，引导 LLM 产出结构化 JSON 而非 markdown。
// 借鉴 Presenton (Zod Schema) + AWS (slideFormat mapping) 模式。
// ============================================================================

import type { LayoutType } from './types';

// ============================================================================
// Per-Layout Content Schemas
// ============================================================================

/** Stats 布局内容：3-4 项大数字指标卡片 */
export interface StatsContent {
  stats: Array<{
    label: string;        // 指标名称（如"全球市场"）
    value: string;        // 数值（如"1500亿"）
    description?: string; // 补充说明（如"年增长率 35%"）
  }>;
}

/** Cards2 布局内容：左侧主卡片 + 右侧次要卡片列表 */
export interface Cards2Content {
  mainCard: { title: string; description: string };
  cards: Array<{ title: string; description: string }>;  // 2-3 项
}

/** Cards3 布局内容：3 个并排卡片 */
export interface Cards3Content {
  cards: Array<{ title: string; description: string }>;  // 恰好 3 项
}

/** List 布局内容：3-6 个要点 */
export interface ListContent {
  points: string[];  // 每项 15-50 字
}

/** Timeline 布局内容：3-5 步流程 */
export interface TimelineContent {
  steps: Array<{
    title: string;       // 步骤标题
    description: string; // 步骤描述
  }>;
}

/** Comparison 布局内容：左右对比 */
export interface ComparisonContent {
  left: { title: string; points: string[] };
  right: { title: string; points: string[] };
}

/** Quote 布局内容：引言 */
export interface QuoteContent {
  quote: string;        // 引言正文
  attribution: string;  // 出处/作者
}

/** Chart 布局内容：左侧要点 + 右侧图表 */
export interface ChartContent {
  points: string[];     // 左侧要点
  chartData?: {
    labels: string[];
    values: number[];
    chartType: 'bar' | 'line' | 'doughnut';
  };
}

/** Highlight 布局内容：2-4 个关键词 */
export interface HighlightContent {
  points: string[];  // 2-4 个关键要点
}

/** TwoColumn 布局内容：双列要点 */
export interface TwoColumnContent {
  leftPoints: string[];
  rightPoints: string[];
}

// 所有布局内容的联合类型
export type LayoutContent =
  | StatsContent
  | Cards2Content
  | Cards3Content
  | ListContent
  | TimelineContent
  | ComparisonContent
  | QuoteContent
  | ChartContent
  | HighlightContent
  | TwoColumnContent;

// ============================================================================
// Structured Slide Definition
// ============================================================================

/** 结构化幻灯片定义 */
export interface StructuredSlide {
  layout: LayoutType;
  title: string;
  subtitle?: string;
  content: LayoutContent;
  isTitle?: boolean;
  isEnd?: boolean;
  /** Speaker notes (chain-of-speech): 1-3 段，100-200 字，口述用 */
  speakerNotes?: string;
}

// ============================================================================
// Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type MutableRecord = Record<string, unknown>;
type SlideContentValidator = (content: unknown) => string[];

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === 'object' && value !== null;
}

function getArrayField(record: MutableRecord, key: string): unknown[] | null {
  const value = record[key];
  return Array.isArray(value) ? value : null;
}

function hasValue(value: unknown): boolean {
  return Boolean(value);
}

/** 验证 Stats 内容 */
function validateStats(content: unknown): string[] {
  const errors: string[] = [];
  const record = isRecord(content) ? content : {};
  const stats = getArrayField(record, 'stats');
  if (!stats) {
    errors.push('stats: 缺少 stats 数组');
    return errors;
  }
  if (stats.length < 2 || stats.length > 5) {
    errors.push(`stats: 需要 2-5 项，当前 ${stats.length} 项`);
  }
  for (const [i, item] of stats.entries()) {
    const stat = isRecord(item) ? item : {};
    if (!hasValue(stat.label)) errors.push(`stats[${i}]: 缺少 label`);
    if (!hasValue(stat.value)) errors.push(`stats[${i}]: 缺少 value`);
  }
  return errors;
}

/** 验证 Cards2 内容 */
function validateCards2(content: unknown): string[] {
  const errors: string[] = [];
  const record = isRecord(content) ? content : {};
  if (!record.mainCard) {
    errors.push('cards-2: 缺少 mainCard');
  } else {
    const mainCard = isRecord(record.mainCard) ? record.mainCard : {};
    if (!hasValue(mainCard.title)) errors.push('cards-2: mainCard 缺少 title');
    if (!hasValue(mainCard.description)) errors.push('cards-2: mainCard 缺少 description');
  }
  const cards = getArrayField(record, 'cards');
  if (!cards) {
    errors.push('cards-2: 缺少 cards 数组');
  } else if (cards.length < 1 || cards.length > 4) {
    errors.push(`cards-2: cards 需要 1-4 项，当前 ${cards.length} 项`);
  }
  return errors;
}

/** 验证 Cards3 内容 */
function validateCards3(content: unknown): string[] {
  const errors: string[] = [];
  const record = isRecord(content) ? content : {};
  const cards = getArrayField(record, 'cards');
  if (!cards) {
    errors.push('cards-3: 缺少 cards 数组');
  } else if (cards.length !== 3) {
    errors.push(`cards-3: 需要恰好 3 项，当前 ${cards.length} 项`);
  }
  return errors;
}

/** 验证 List 内容 */
function validateList(content: unknown): string[] {
  const errors: string[] = [];
  const record = isRecord(content) ? content : {};
  const points = getArrayField(record, 'points');
  if (!points) {
    errors.push('list: 缺少 points 数组');
  } else if (points.length < 2 || points.length > 8) {
    errors.push(`list: 需要 2-8 项，当前 ${points.length} 项`);
  }
  return errors;
}

/** 验证 Timeline 内容 */
function validateTimeline(content: unknown): string[] {
  const errors: string[] = [];
  const record = isRecord(content) ? content : {};
  const steps = getArrayField(record, 'steps');
  if (!steps) {
    errors.push('timeline: 缺少 steps 数组');
  } else {
    if (steps.length < 2 || steps.length > 5) {
      errors.push(`timeline: 需要 2-5 步，当前 ${steps.length} 步`);
    }
    for (const [i, item] of steps.entries()) {
      const step = isRecord(item) ? item : {};
      if (!hasValue(step.title)) errors.push(`timeline.steps[${i}]: 缺少 title`);
      if (!hasValue(step.description)) errors.push(`timeline.steps[${i}]: 缺少 description`);
    }
  }
  return errors;
}

/** 验证 Comparison 内容（容错：自动修正结构） */
function validateComparison(content: unknown): string[] {
  const errors: string[] = [];
  const record = isRecord(content) ? content : {};
  if (!record.left || !record.right) {
    errors.push('comparison: 缺少 left 或 right');
    return errors;
  }

  // 容错：如果 left/right 是数组，自动转换为 {title: "", points: [...]}
  if (Array.isArray(record.left)) {
    record.left = { title: '', points: record.left };
  }
  if (Array.isArray(record.right)) {
    record.right = { title: '', points: record.right };
  }

  // 容错：如果 left/right 是字符串，包装为 points
  if (typeof record.left === 'string') {
    record.left = { title: '', points: [record.left] };
  }
  if (typeof record.right === 'string') {
    record.right = { title: '', points: [record.right] };
  }

  // 容错：提取 points — 如果 left/right 是对象但没有 points，尝试从值数组中提取
  if (isRecord(record.left) && !record.left.points) {
    const values = Object.values(record.left).filter(v => typeof v === 'string' || Array.isArray(v));
    if (values.length > 0) {
      const pts = values.flatMap((v): unknown[] => Array.isArray(v) ? (v as unknown[]) : [v]);
      record.left = { title: typeof record.left.title === 'string' ? record.left.title : '', points: pts };
    }
  }
  if (isRecord(record.right) && !record.right.points) {
    const values = Object.values(record.right).filter(v => typeof v === 'string' || Array.isArray(v));
    if (values.length > 0) {
      const pts = values.flatMap((v): unknown[] => Array.isArray(v) ? (v as unknown[]) : [v]);
      record.right = { title: typeof record.right.title === 'string' ? record.right.title : '', points: pts };
    }
  }

  const left = isRecord(record.left) ? record.left : {};
  const right = isRecord(record.right) ? record.right : {};

  // title 非必须（容错后默认空字符串）
  if (!Array.isArray(left.points)) {
    errors.push('comparison: left 缺少 points 数组');
  }
  if (!Array.isArray(right.points)) {
    errors.push('comparison: right 缺少 points 数组');
  }
  return errors;
}

/** 验证 Quote 内容 */
function validateQuote(content: unknown): string[] {
  const errors: string[] = [];
  const record = isRecord(content) ? content : {};
  if (!hasValue(record.quote)) errors.push('quote: 缺少 quote');
  if (!hasValue(record.attribution)) errors.push('quote: 缺少 attribution');
  return errors;
}

/** 验证 Chart 内容 */
function validateChart(content: unknown): string[] {
  const errors: string[] = [];
  const record = isRecord(content) ? content : {};
  const points = getArrayField(record, 'points');
  if (!points) {
    errors.push('chart: 缺少 points 数组');
  }
  if (record.chartData) {
    const chartData = isRecord(record.chartData) ? record.chartData : {};
    if (!Array.isArray(chartData.labels)) {
      errors.push('chart: chartData 缺少 labels');
    }
    if (!Array.isArray(chartData.values)) {
      errors.push('chart: chartData 缺少 values');
    }
  }
  return errors;
}

// 布局 → 验证器映射
const VALIDATORS: Partial<Record<LayoutType, SlideContentValidator>> = {
  'stats': validateStats,
  'cards-2': validateCards2,
  'cards-3': validateCards3,
  'list': validateList,
  'timeline': validateTimeline,
  'comparison': validateComparison,
  'quote': validateQuote,
  'chart': validateChart,
  'highlight': validateList,     // highlight 复用 list 验证
  'two-column': validateList,    // two-column 也验证 points 存在性
};

const VALID_LAYOUTS: LayoutType[] = [
  'stats', 'cards-2', 'cards-3', 'list', 'highlight',
  'timeline', 'chart', 'quote', 'comparison', 'two-column',
];

/**
 * 验证单张结构化 Slide 的内容是否符合其布局 schema
 */
export function validateSlideContent(slide: StructuredSlide): ValidationResult {
  const errors: string[] = [];

  if (!slide.title) {
    errors.push('缺少 title');
  }

  if (!slide.layout) {
    errors.push('缺少 layout');
  } else if (!VALID_LAYOUTS.includes(slide.layout)) {
    errors.push(`未知 layout: "${slide.layout}"，可用: ${VALID_LAYOUTS.join(', ')}`);
  }

  // 封面/结尾页跳过严格内容验证（只需 title 和 layout）
  if (slide.isTitle || slide.isEnd) {
    return { valid: errors.length === 0, errors };
  }

  if (!slide.content) {
    errors.push('缺少 content');
  } else {
    // 容错：如果 content 是字符串，尝试解析
    let contentObj: unknown = slide.content;
    if (typeof contentObj === 'string') {
      try { contentObj = JSON.parse(contentObj); } catch { /* keep as-is */ }
    }

    const validator = VALIDATORS[slide.layout];
    if (validator) {
      errors.push(...validator(contentObj));
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 容错：从 slide 顶层字段重建 content 对象
 * 解决 LLM 将 content 内容"上提"到顶层的问题：
 * {layout:"stats", stats:[...]} → {layout:"stats", content:{stats:[...]}}
 */
function normalizeSlideContent(slide: StructuredSlide): StructuredSlide {
  const raw = slide as unknown as Record<string, unknown>;
  const rawLayout = raw.layout;
  // 容错：layout="title"/"end" 映射为 list + isTitle/isEnd
  if (rawLayout === 'title') {
    return { ...slide, layout: 'list', isTitle: true, content: { points: (raw.points as string[] | undefined) || [] } };
  }
  if (rawLayout === 'end') {
    return { ...slide, layout: 'list', isEnd: true, content: { points: (raw.points as string[] | undefined) || [] } };
  }

  if (isRecord(slide.content) && Object.keys(slide.content).length > 0) {
    return slide; // content 已正确填充
  }

  // 尝试从顶层字段重建 content
  const layoutKeys: Record<string, string[]> = {
    'stats': ['stats'],
    'cards-2': ['mainCard', 'cards'],
    'cards-3': ['cards'],
    'list': ['points'],
    'timeline': ['steps'],
    'comparison': ['left', 'right'],
    'quote': ['quote', 'attribution'],
    'chart': ['points', 'chartData'],
    'highlight': ['points'],
    'two-column': ['leftPoints', 'rightPoints'],
  };

  const keys = typeof rawLayout === 'string' ? layoutKeys[rawLayout] : undefined;
  if (!keys) return slide;

  const content: Record<string, unknown> = {};
  let hasContent = false;
  for (const key of keys) {
    if (raw[key] !== undefined) {
      content[key] = raw[key];
      hasContent = true;
    }
  }

  if (hasContent) {
    return { ...slide, content: content as unknown as LayoutContent };
  }

  return slide;
}

/**
 * 批量验证 StructuredSlide 数组
 * 返回通过验证的 slides 和错误信息
 */
export function validateStructuredSlides(slides: StructuredSlide[]): {
  validSlides: StructuredSlide[];
  errors: Array<{ index: number; errors: string[] }>;
} {
  const validSlides: StructuredSlide[] = [];
  const allErrors: Array<{ index: number; errors: string[] }> = [];

  for (let i = 0; i < slides.length; i++) {
    // 先尝试容错修复 content 结构
    const normalized = normalizeSlideContent(slides[i]);
    const result = validateSlideContent(normalized);
    if (result.valid) {
      validSlides.push(normalized);
    } else {
      allErrors.push({ index: i, errors: result.errors });
    }
  }

  return { validSlides, errors: allErrors };
}

// ============================================================================
// Layout Schema Description（用于工具描述，引导 LLM）
// ============================================================================

/**
 * 生成布局 Schema 描述文本，嵌入工具描述中引导 LLM 产出结构化 JSON
 */
export function getLayoutSchemaDescription(): string {
  return `结构化幻灯片定义（推荐，优于 content 参数）。
每张 slide 指定 layout + title + 对应 content 结构。

可用 layout 及其 content 格式：
- "stats": { stats: [{label, value, description?}] } (3-4项大数字指标)
- "cards-2": { mainCard: {title, description}, cards: [{title, description}] } (左大右小卡片)
- "cards-3": { cards: [{title, description}] } (恰好3张并排卡片)
- "list": { points: string[] } (3-6项要点，每项20-50字)
- "timeline": { steps: [{title, description}] } (3-5步流程)
- "comparison": { left: {title, points}, right: {title, points} } (左右对比)
- "quote": { quote: string, attribution: string } (引言)
- "chart": { points: string[], chartData?: {labels, values, chartType} } (要点+图表)

示例：
[
  { "layout": "stats", "title": "市场规模", "content": {
    "stats": [
      {"label": "全球市场", "value": "1500亿", "description": "年增长率 35%"},
      {"label": "中国市场", "value": "320亿", "description": "占比 21%"},
      {"label": "企业用户", "value": "50万+", "description": "同比翻倍"}
    ]
  }},
  { "layout": "timeline", "title": "实施路线", "content": {
    "steps": [
      {"title": "需求分析", "description": "调研用户需求，明确产品定位"},
      {"title": "原型设计", "description": "低保真原型验证核心交互"},
      {"title": "开发测试", "description": "敏捷迭代，每周发布"}
    ]
  }}
]

注意：
- 第 1 页建议设 isTitle: true
- 最后 1 页建议设 isEnd: true
- 相邻页面避免使用相同 layout
- 每页建议附带 speakerNotes（1-3 段，100-200 字，演讲者口述用）`;
}
