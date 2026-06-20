/**
 * 设计质量检测器契约。
 *
 * 检测器是一个零依赖、基于源码文本的扫描器，用于标记 AI 生成前端的
 * "痕迹"（slop）与通用设计品味问题。它运行在 Node 侧（无 DOM），只
 * 工作在原始源码文本（HTML / CSS / JSX / TSX / SVG）上——绝不依赖
 * 渲染后的 DOM 或计算样式。规则刻意牺牲一点召回换高精度，让回注给
 * 模型的发现可信。
 *
 * 设计启发式算法移植自公开的 impeccable（Apache-2.0）design-lint 规则
 * ——仅算法，命名与中文文案为本项目自有。
 */

/** 发现的响亮程度。`advisory` 为启发式规则。 */
export type DesignFindingSeverity = 'warning' | 'advisory';

/**
 * `slop` = AI 生成痕迹（紫蓝渐变、弹跳缓动……）。
 * `quality` = 通用品味问题（行宽、标题层级……）。
 * `drift` = 偏离项目声明的设计语境。
 */
export type DesignRuleCategory = 'slop' | 'quality' | 'drift';

/**
 * 检测激进度。`relaxed` 只报最可靠的 slop 痕迹；`standard` 加入品味 +
 * 明确的 slop；`strict` 再加入偶有误报的启发式规则。
 */
export type DesignStrictness = 'relaxed' | 'standard' | 'strict';

export const DESIGN_STRICTNESS_LEVELS: readonly DesignStrictness[] = [
  'relaxed',
  'standard',
  'strict',
];

/** 源码文件中发现的单个设计问题。 */
export type DesignFinding = {
  ruleId: string;
  category: DesignRuleCategory;
  severity: DesignFindingSeverity;
  /** 可读、可执行的中文描述。 */
  message: string;
  /** 1-based 行号。 */
  line: number;
  /** 该行周边的简短源码上下文（裁剪、限长）。 */
  snippet: string;
};

/**
 * 检测器可据以核对源码的项目设计意图。来自 SDD 需求的设计语境或工作
 * 区调色板。所有字段可选——drift 规则在输入缺失时静默不报。
 */
export type DesignContext = {
  designType?: 'brand' | 'product';
  brandColor?: string;
  tone?: readonly string[];
  /** 项目认可的字族；其余标记为 drift。 */
  allowedFonts?: readonly string[];
};

export type DetectOptions = {
  /** 用于扩展名门控、忽略匹配与发现上下文。 */
  filePath?: string;
  strictness?: DesignStrictness;
  /** 完全抑制的规则 id。 */
  ignoreRules?: readonly string[];
  designContext?: DesignContext;
  /** 返回发现的硬上限（默认 12）。 */
  maxFindings?: number;
};

/** 描述单条检测规则的静态元数据（供 UI 与文档使用）。 */
export type DesignRuleMeta = {
  id: string;
  category: DesignRuleCategory;
  severity: DesignFindingSeverity;
  /** 该规则触发的最低严格度。 */
  minStrictness: DesignStrictness;
  /** 供设置 UI 用的简短中文标题。 */
  title: string;
};
