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
