/**
 * 设计质量检测器——Neo 自有的前端产出 linter。
 *
 * 用确定性、基于源码的规则，标记前端源码（HTML / CSS / JSX / TSX /
 * SVG）里的 AI 生成设计"痕迹"与品味问题。由内置 PostToolUse 钩子调用，
 * 把发现回注给模型让其自我修正；也可供其他界面（设置、SDD 设计 tab）使用。
 *
 * 设计启发式移植自公开的 impeccable（Apache-2.0）lint 规则——仅算法，
 * 命名与中文文案为本项目自有。借鉴自竞品 Kun（DeepSeek-GUI）的设计
 * 质量自检机制，详见 内部文档。
 */

export {
  detectFrontend,
  isFrontendPath,
  extensionOf,
  listDesignRules,
  FRONTEND_EXTENSIONS,
} from './detect';
export { DESIGN_RULES, type RuleContext, type RuleHit, type DesignRule } from './rules';
export {
  DESIGN_STRICTNESS_LEVELS,
  type DesignFinding,
  type DesignFindingSeverity,
  type DesignRuleCategory,
  type DesignRuleMeta,
  type DesignContext,
  type DesignStrictness,
  type DetectOptions,
} from './types';
