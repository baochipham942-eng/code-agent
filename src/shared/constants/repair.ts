export const REPAIR_PROMPT_LIMITS = {
  MAX_EVIDENCE_LENGTH: 220,
  MAX_PROMPT_ISSUES: 3,
  // 2000 是 rebase merge 时劳拉调过的妥协值：艾克斯原本砍到 1500（vs main 3600）
  // 求 prompt 精炼，但 platformer 测试有 ≥3 个 issue + hints + evidence echo，
  // 1500 会把最后一条 evidence 截断。2000 保留精炼意图同时让测试通过。
  MAX_PROMPT_CHARS: 2000,
  HISTORY_ITEM_LIMIT: 4,
  HISTORY_ITEM_CHARS: 140,
} as const;

// Route A: the single hard stop for artifact repair. The repair loop is bounded
// by two independent gates that both use this limit:
//   - attempts: failed validation passes (catches the failing-patch loop)
//   - repairTurnsWithoutProgress: repair turns with no successful target mutation
//     (catches unavailable-tool spam and read loops)
// When either reaches this value the repair turn is force-stopped.
export const ARTIFACT_REPAIR_MAX_ATTEMPTS = 4;

// ============================================================
// 修复策略裁决（patience + 修复/重写双信号，maka 借鉴批 WP3）
// 行业对齐：OpenHands StuckDetector（重复模式 4 次硬停）、
// Cursor/从业共识（连败 2-3 次=上下文污染该重开）、
// Agentless/Codex（多候选独立生成+验证器挑选优于深度串行修复）。
// ============================================================

/** 连续多少轮未刷新"历史最少失败项"→ 停止盲修（切策略或放行） */
export const ARTIFACT_REPAIR_PATIENCE_ROUNDS = 2;

/** 同一失败码连续存活多少轮 → 判定为"补丁修不动"，直接切重写不等 patience */
export const ARTIFACT_REPAIR_RESISTANT_STREAK = 2;

/**
 * 补丁抗性失败码（静态分类）：跨函数行为一致性问题，补丁式修复实测低效
 * （dogfood：stomp_enemy 类机制失败 3 轮修不动且第 6 轮把别处改坏）。
 * 命中且存活 ≥RESISTANT_STREAK 轮 → 触发干净上下文重写。
 */
export const ARTIFACT_REPAIR_PATCH_RESISTANT_CODES = [
  'run_smoke_failed',
  'control_no_state_change',
  'coverage_without_runtime_evidence',
  'smoke_missing_coverage',
  'shortcut_state_mutation',
  'reset_authored_unit_failed',
  'level_coverage_incomplete',
] as const;

// 工具入参 schema 校验失败的 repair 闸上限（Kimi 借鉴 #1）。
// 与 ARTIFACT_REPAIR（patch/产物修复）是两条独立循环：这条针对"模型反复对
// 同一工具传错参数"——每次失败把 schema 回灌让模型自我修正，但连续失败超过
// 本上限后停止重注入，改注入终止指引让模型换路子，避免 Kimi 那种"卡死循环
// 狂烧 token"。上限取 2（backlog 护栏"repair 上限 1-2 次"）。
export const TOOL_ARGS_REPAIR_MAX_ATTEMPTS = 2;
