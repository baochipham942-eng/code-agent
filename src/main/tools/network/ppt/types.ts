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
export type LayoutType = 'stats' | 'cards-2' | 'cards-3' | 'list' | 'highlight' | 'timeline' | 'chart';

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
}

// 图表类型定义（mermaidToNative 用）
export type DiagramType = 'agent-loop' | 'skills' | 'sandbox' | 'lsp-compare' | 'none';
