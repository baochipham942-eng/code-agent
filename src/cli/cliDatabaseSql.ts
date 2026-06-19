// ============================================================================
// CLI Database SQL 片段助手 — 从 database.ts 纯结构性拆出（零行为改动）
// where 子句构造器，被 CLIDatabaseService 与 cliDatabaseSchema 共用。
// ============================================================================

export function loopInternalMessageWhere(alias = 'm'): string {
  return `COALESCE(${alias}.content, '') NOT LIKE '%【循环模式 · 第%轮】%' AND COALESCE(${alias}.content, '') NOT LIKE '%[[LOOP_WAIT]]%'`;
}

export function visibleHistoryMessageWhere(alias = 'm'): string {
  return `COALESCE(${alias}.is_meta, 0) = 0 AND ${loopInternalMessageWhere(alias)}`;
}
