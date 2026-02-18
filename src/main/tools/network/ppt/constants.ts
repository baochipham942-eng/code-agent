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
