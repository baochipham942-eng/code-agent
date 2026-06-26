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
