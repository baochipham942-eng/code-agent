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

// 工具入参 schema 校验失败的 repair 闸上限（Kimi 借鉴 #1）。
// 与 ARTIFACT_REPAIR（patch/产物修复）是两条独立循环：这条针对"模型反复对
// 同一工具传错参数"——每次失败把 schema 回灌让模型自我修正，但连续失败超过
// 本上限后停止重注入，改注入终止指引让模型换路子，避免 Kimi 那种"卡死循环
// 狂烧 token"。上限取 2（backlog 护栏"repair 上限 1-2 次"）。
export const TOOL_ARGS_REPAIR_MAX_ATTEMPTS = 2;
