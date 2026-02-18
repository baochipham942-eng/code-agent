// ============================================================================
// PPT 共享类型定义
// ============================================================================

// PPT 风格主题
export type PPTTheme =
  | 'neon-green'    // 深黑 + 荧光绿（科技感）
  | 'neon-blue'     // 深黑 + 电光蓝（专业感）
  | 'neon-purple'   // 深紫 + 粉紫霓虹（创意感）
  | 'neon-orange'   // 深灰 + 橙色霓虹（活力感）
  | 'glass-light'   // 浅色玻璃态（简约感）
  | 'glass-dark'    // 深色玻璃态（高端感）
  | 'minimal-mono'  // 纯黑白（极简感）
  | 'corporate'     // 企业蓝（商务感）
  | 'apple-dark';   // 苹果发布会极简风格

// 幻灯片布局类型（输入 schema 用）
export type SlideLayout = 'title' | 'bento' | 'bento-2' | 'bento-3' | 'full-image' | 'split' | 'quote' | 'data' | 'code';

// 内容布局类型（内部渲染用）
export type LayoutType = 'stats' | 'cards-2' | 'cards-3' | 'list' | 'highlight' | 'timeline' | 'chart' | 'quote' | 'comparison' | 'two-column';

// 图表模式
export type ChartMode = 'auto' | 'none';

// 图表类型
export type ChartType = 'bar' | 'bar3D' | 'doughnut' | 'line' | 'pie';

// 主题配置
export interface ThemeConfig {
  name: string;
  bgColor: string;           // 主背景色
  bgSecondary: string;       // 次级背景（卡片/Bento）
  textPrimary: string;       // 主文字色
  textSecondary: string;     // 次级文字色
  accent: string;            // 霓虹强调色
  accentGlow: string;        // 强调色发光版（更亮）
  cardBorder: string;        // 卡片边框
  isDark: boolean;
  fontTitle: string;
  fontBody: string;
  fontCode: string;
  fontTitleCN?: string;      // CJK 标题字体
  fontBodyCN?: string;       // CJK 正文字体
}

// 幻灯片图片
export interface SlideImage {
  slide_index: number;
  image_path: string;
  position?: 'right' | 'left' | 'center' | 'background' | 'bento';
}

// 幻灯片数据
export interface SlideData {
  title: string;
  subtitle?: string;
  points: string[];
  layout?: SlideLayout;
  isTitle?: boolean;
  isEnd?: boolean;
  code?: { language: string; content: string };
  table?: { headers: string[]; rows: string[][] };
}

// 图表槽数据
export interface ChartSlotData {
  chartType: ChartType;
  labels: string[];
  values: number[];
  title?: string;
}

// PPT 生成参数
export interface PPTGenerateParams {
  topic: string;
  content?: string;
  slides_count?: number;
  theme?: PPTTheme;
  output_path?: string;
  images?: SlideImage[];
  use_masters?: boolean;
  chart_mode?: ChartMode;
  normalize_density?: boolean;   // D3: 启用信息密度控制
  mode?: 'generate' | 'template' | 'design'; // D1: 生成模式 + Design Mode
  template_path?: string;        // D1: 模板文件路径（Phase 2）
  placeholders?: Record<string, string>; // D1: 占位符替换（Phase 2）
  data_source?: string;          // D2: 数据源文件路径（Phase 2）
  preview?: boolean;             // D5: 仅预览不生成（Phase 3）
  slides?: import('./slideSchemas').StructuredSlide[]; // 结构化 JSON 输入（优先于 content）
  // v7 新工作流参数
  research?: boolean;            // 启用深度搜索（默认 true）
  review?: boolean;              // 启用 VLM 视觉审查（默认 true）
  template_refs?: string[];      // 用于多模板融合的模板路径列表
}

// 图表类型定义（mermaidToNative 用）
export type DiagramType = 'agent-loop' | 'skills' | 'sandbox' | 'lsp-compare' | 'none';

// ============================================================================
// v7 新工作流类型定义
// ============================================================================

/** ① 主题理解结果 */
export interface TopicBrief {
  topic: string;
  audience: 'investor' | 'technical' | 'management' | 'general';
  style: 'business' | 'tech' | 'academic' | 'creative' | 'marketing';
  slideCount: number;
  keywords: string[];
}

/** 搜索结果中提取的事实 */
export interface ResearchFact {
  content: string;
  source: string;       // URL
  type: 'fact' | 'statistic' | 'quote' | 'case';
}

/** ② 深度搜索结果 */
export interface ResearchContext {
  facts: ResearchFact[];
  statistics: Array<{
    label: string;
    value: string;
    source: string;
    description?: string;
  }>;
  quotes: Array<{
    text: string;
    attribution: string;
    source: string;
  }>;
  sources: Array<{
    url: string;
    title: string;
    relevance: number;  // 0-1
  }>;
}

/** ③ 模板元数据 */
export interface TemplateMetadata {
  id: string;
  file: string;
  domains: string[];
  style: 'dark' | 'light';
  layouts: string[];
  colorContrast: number;
  preview?: string;
  status?: 'available' | 'planned';
}

/** 模板分析结果（单个模板） */
export interface TemplateProfile {
  id: string;
  filePath: string;
  layouts: Array<{
    name: string;
    placeholders: Array<{
      name: string;
      type: 'title' | 'body' | 'image' | 'chart' | 'other';
      x: number;
      y: number;
      w: number;
      h: number;
    }>;
  }>;
  colorScheme: {
    background: string;
    text: string;
    accent: string;
    secondary: string;
  };
  fonts: {
    title: string;
    body: string;
    titleCN?: string;
    bodyCN?: string;
  };
}

/** ④ 融合后的多模板配置 */
export interface MergedTemplateProfile {
  layouts: string[];
  bestSource: Record<string, string>;  // layout → templateId
  colorScheme: TemplateProfile['colorScheme'];
  fonts: TemplateProfile['fonts'];
  templatePaths: string[];             // Top 3 模板文件路径
}

/** 审查维度类型（8 维度，3 层） */
export type ReviewDimensionType =
  // Layer 1: 硬性规则（各 15%，合计 45%）
  | 'text_readability'       // D1: 文本可读性（合并 text_overflow + low_contrast + 字号层级）
  | 'layout_precision'       // D2: 布局精度（合并 element_overlap + alignment）
  | 'information_density'    // D3: 信息密度（density_imbalance 升级版）
  // Layer 2: 视觉质量（各 12.5%，合计 37.5%）
  | 'visual_hierarchy'       // D4: 视觉层级
  | 'color_contrast'         // D5: 色彩与对比
  | 'consistency'            // D6: 一致性与重复（跨页风格统一）
  // Layer 3: 主观审美（各 7.5%，合计 15% + 2.5% 保留）
  | 'composition'            // D7: 构图与平衡
  | 'professional_polish';   // D8: 专业度

/** 维度权重配置 */
export const REVIEW_DIMENSION_WEIGHTS: Record<ReviewDimensionType, number> = {
  text_readability: 0.15,
  layout_precision: 0.15,
  information_density: 0.15,
  visual_hierarchy: 0.125,
  color_contrast: 0.125,
  consistency: 0.125,
  composition: 0.075,
  professional_polish: 0.075,
};

/** ⑨ VLM 审查结果 */
export interface ReviewResult {
  slideIndex: number;
  score: number;         // 1-5（加权平均）
  issues: Array<{
    type: ReviewDimensionType;
    description: string;
    severity: 'high' | 'medium' | 'low';
    fix?: string;
    weight: number;      // 维度权重
  }>;
  suggestions: string[];
}

/** ⑩ 自动修正建议 */
export interface FixSuggestion {
  slideIndex: number;
  action: 'shorten_text' | 'reduce_font' | 'redistribute' | 'adjust_color' | 'change_layout';
  details: string;
}

/** VLM（视觉语言模型）回调 — 接收 prompt + 图片路径 */
export type VlmCallback = (prompt: string, imagePath: string) => Promise<string>;

/** 幻灯片资产 */
export interface SlideAssets {
  charts: Array<{ slideIndex: number; chartData: ChartSlotData }>;
  images: Array<{ slideIndex: number; imagePath: string; position: string }>;
}
