/**
 * Game acceptance architecture — shared constants.
 *
 * 背景: 内部文档 §5。
 * 这里收口所有 game subtype dispatcher / skill loader / verb taxonomy 用到的字面量，
 * 避免 game/types.ts、game/verbs.ts、game/skill-loader.ts 各自硬编码。
 */

/**
 * Top-level artifact kinds the dispatcher knows about.
 * 与 §5.1 Layer A 对齐 — TS hard dispatch，5–10 个稳定 kind。
 */
export const ARTIFACT_KINDS = [
  'game',
  'slide-deck',
  'document',
  'data-workbook',
  'dashboard',
  'code-project',
  'image',
  'other',
] as const;

/** 6-class verb taxonomy — §4.4 Mechanics 跨流派词汇表 */
export const VERB_CLASSES = [
  'movement',
  'acquisition',
  'conflict',
  'construction',
  'cognition',
  'progression',
] as const;

/** SKILL.md frontmatter / body 的解析参数 */
export const SKILL_LOADER_DEFAULTS = {
  /** Skill manifest 文件名 */
  MANIFEST_FILENAME: 'SKILL.md',
  /** YAML frontmatter delimiter */
  FRONTMATTER_DELIMITER: '---',
} as const;

/** Game artifact 校验超时（validation lifecycle / repair admission 共用） */
export const GAME_VALIDATION_TIMEOUTS = {
  /** goal 模式重契约 runtime smoke（浏览器驱动测试合约） */
  RUNTIME_SMOKE_MS: 7000,
  /** goal 模式浏览器视觉冒烟（多视口截查） */
  BROWSER_VISUAL_SMOKE_MS: 10000,
  /** light 契约可玩性冒烟（真实加载+按键，只抓硬崩溃/全黑画面） */
  LIGHT_PLAYABILITY_SMOKE_MS: 6000,
  /**
   * 产物冒烟页面启动预算：system Chrome CDP 等待 + 回退 bundled launch 共用的
   * 独立预算，不占用调用方的 smoke deadline（deadline 从页面就绪后才起算）。
   * 冷启动+CPU 饥饿的 CI runner 上 chrome 首次起 CDP 可到 6-8s+，此预算给了
   * 冒烟预算（如 800ms squeeze 用例）之外的自有额度，避免把「启动慢」误算进
   * 「产物跑不动」。N-TEST-GAMESMOKE-FLAKY。
   */
  ARTIFACT_PAGE_LAUNCH_MS: 8000,
} as const;
