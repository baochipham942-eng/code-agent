// ============================================================================
// PPT 模块常量 — 集中管理 PPT 生成模块的配置值
// ============================================================================
// 遵循 shared/constants.ts 的管理模式，PPT 模块内禁止散布魔法数字
// ============================================================================

// ---- 图表 ----

/** 图表数量级校验：最大值/最小值比超过此阈值则不适合同一图表 */
export const CHART_SCALE_MAX_RATIO = 1000;

/** 图表标签/数据最大切片数 */
export const CHART_MAX_ITEMS = 6;

/** 图表数据最少数据点数 */
export const CHART_MIN_DATA_POINTS = 3;

/** 图表标签前缀最大字符数（超过说明数字不是核心信息） */
export const CHART_LABEL_MAX_PREFIX = 15;

/** 图表标签截断长度 */
export const CHART_LABEL_MAX_LENGTH = 20;

// ---- 内容检测正则 ----

/** 数据相关关键词（标题必须含这些词才启用图表检测） */
export const DATA_KEYWORDS_PATTERN = /数据|统计|市场|规模|增长|趋势|占比|份额|对比|排名|指标|data|market|stats|growth/i;

/** 百分比/占比关键词 → 环形图 */
export const CHART_DOUGHNUT_PATTERN = /占比|比例|份额|分布|percent|share|ratio/i;

/** 时间序列关键词 → 折线图 */
export const CHART_LINE_PATTERN = /趋势|增长|变化|年|月|季度|trend|growth|timeline|year|month/i;

/** 排名/对比关键词 → 条形图 */
export const CHART_BAR_PATTERN = /排名|排行|对比|top|rank|compare/i;

/** 数字提取模式（含单位） */
export const NUMBER_WITH_UNIT_PATTERN = /\d+[\d.,]*[%万亿KMB]?/i;

/** 流程/步骤检测（仅标题） → timeline 布局 */
export const PROCESS_PATTERN = /流程|步骤|阶段|step|phase|stage/i;

/** 对比检测 → comparison 布局 */
export const COMPARISON_PATTERN = /对比|比较|vs|区别|优势|劣势|特点/i;

/** 重点检测（仅标题） → highlight 布局 */
export const KEY_POINT_PATTERN = /核心|关键|重点|最重要|价值|意义/i;

/** 技术检测（仅标题） → cards 布局 */
export const TECHNICAL_PATTERN = /架构|技术|实现|原理|算法|系统|模块/i;

/** 引用检测（仅标题 + 要点 ≤2） → quote 布局 */
export const QUOTE_PATTERN = /引言|语录|名言|格言|quote|saying/i;

// ---- 布局节奏 ----

/** 布局节奏控制配置 */
export const LAYOUT_RHYTHM = {
  /** 连续相同布局的最大次数 */
  MAX_CONSECUTIVE_SAME: 2,
  /** 连续 stats 布局的最大次数 */
  MAX_CONSECUTIVE_STATS: 1,
  /** 多样性检查的回溯窗口大小 */
  DIVERSITY_WINDOW: 5,
  /** 窗口内同一布局最大出现次数 */
  MAX_IN_WINDOW: 2,
} as const;

// ---- 幻灯片尺寸 ----

/** 标准 16:9 宽屏幻灯片尺寸（英寸） */
export const SLIDE = {
  WIDTH: 10,
  HEIGHT: 5.63,
} as const;

// ---- 设计模式画布 ----

/** Design Mode 脚手架画布常量（注入到 LLM 生成的脚本中） */
export const DESIGN_CANVAS = {
  WIDTH: 13.33,
  HEIGHT: 7.5,
  MARGIN_X: 0.7,
  MARGIN_Y: 0.5,
} as const;

// ---- 文本度量 ----

/** 字符宽度估算因子（英寸/点） — 用于 calculateFitFontSize */
export const TEXT_METRICS = {
  /** CJK 字符宽度因子（近似方形） */
  CJK_WIDTH_FACTOR: 0.035,
  /** Latin 字符宽度因子（较窄） */
  LATIN_WIDTH_FACTOR: 0.02,
  /** 行高乘数 */
  LINE_HEIGHT_FACTOR: 1.3,
  /** CJK 主导判定阈值（CJK 字符占比 > 此值视为 CJK 主导） */
  CJK_DOMINANT_THRESHOLD: 0.3,
} as const;

// ---- 自适应字号 ----

/** 自适应字号阈值配置 */
export const ADAPTIVE_FONT = {
  /** 长文本阈值（等效字符数，超过则减 2pt） */
  LONG_TEXT_THRESHOLD: 80,
  /** 中等文本阈值（等效字符数，超过则减 1pt） */
  MEDIUM_TEXT_THRESHOLD: 50,
  /** 长文本字号减小量 (pt) */
  LONG_TEXT_REDUCTION: 2,
  /** 中等文本字号减小量 (pt) */
  MEDIUM_TEXT_REDUCTION: 1,
  /** 最小字号下限 (pt) */
  MIN_FONT_SIZE: 10,
} as const;

// ---- 设计模式 ----

/** Design Mode 执行配置 */
export const DESIGN_MODE = {
  /** VLM 审查最大修订轮数 */
  MAX_REVISIONS: 2,
  /** L2 降级时的简化页数上限 */
  SIMPLIFIED_SLIDE_COUNT: 8,
  /** 脚本执行超时 (ms) */
  SCRIPT_TIMEOUT: 30_000,
  /** tsx 执行输出缓冲区上限 (bytes) */
  MAX_BUFFER: 10 * 1024 * 1024,
} as const;

// ---- 外部工具超时 ----

/** PDF/图片转换工具超时 (ms) */
export const CONVERT_TIMEOUTS = {
  /** LibreOffice PPTX→PDF */
  PDF_CONVERT: 60_000,
  /** poppler pdftoppm */
  PDFTOPPM: 60_000,
  /** ImageMagick convert/magick */
  IMAGEMAGICK: 120_000,
  /** macOS qlmanage */
  QLMANAGE: 30_000,
} as const;

// ---- PDF 渲染参数 ----

/** PDF 转图片质量参数 */
export const PDF_RENDER = {
  /** JPEG 质量 (0-100) */
  QUALITY: 85,
  /** 渲染分辨率 (DPI) */
  DPI: 150,
  /** macOS qlmanage 缩略图尺寸 (px) */
  QLMANAGE_SIZE: 1920,
} as const;

// ---- 研究数据裁切 ----

/** 注入 Prompt 时研究数据的最大条数 */
export const RESEARCH_SLICE = {
  STATISTICS: 10,
  FACTS: 8,
  QUOTES: 3,
} as const;

// ---- VLM 审查 ----

/** VLM（视觉语言模型）请求超时 (ms) */
export const VLM_REQUEST_TIMEOUT = 60_000;

// ---- LibreOffice ----

/** LibreOffice 路径环境变量名 */
export const LIBREOFFICE_PATH_ENV = 'LIBREOFFICE_PATH';

/** LibreOffice 默认搜索路径（按优先级排序） */
export const LIBREOFFICE_SEARCH_PATHS = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/libreoffice',
  '/usr/local/bin/libreoffice',
];

// ---- 预览 ----

/** 预览截断长度 */
export const PREVIEW_CODE_TRUNCATE = 200;
