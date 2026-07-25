// ============================================================================
// 专家推荐连接器（agent.md frontmatter `connectors`）
// ============================================================================
// 连接器此前是全局的：装了就人人可用，专家自己说不出「我干活要连什么」。
// 这里让专家声明推荐连接器，并给出会话层的三态解析口径。
//
// id 空间对齐 mcpCatalog 的 RECOMMENDED_MCP_SERVERS.id（如 'lark'），与自动化模板卡
// 的 requiredConnectors 同一套，别另起一套命名。
// ============================================================================

export interface ExpertConnector {
  id: string;
  /** core=不连就干不了活，默认开；optional=锦上添花，默认关 */
  level: 'core' | 'optional';
  /** 给人看的一句话：这个专家拿它来干什么 */
  reason?: string;
}

/**
 * frontmatter 里一行一条，竖线分三段：`<id>|<core|optional>|<理由>`。
 *
 * 用扁平串而不是嵌套对象，是因为 agent.md 走的是仓里那个 simple YAML parser
 * （只认 `key: value` 和字符串数组）。理由段可省略；档位段缺省或写错一律当 optional
 * ——「默认关」是安全的那一侧。
 */
export function parseExpertConnectors(entries: readonly string[] | undefined): ExpertConnector[] {
  if (!entries) return [];
  const parsed: ExpertConnector[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const [rawId, rawLevel, ...rest] = entry.split('|');
    const id = rawId?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const reason = rest.join('|').trim();
    parsed.push({
      id,
      level: rawLevel?.trim().toLowerCase() === 'core' ? 'core' : 'optional',
      ...(reason ? { reason } : {}),
    });
  }
  return parsed;
}

/**
 * 三态解析：会话覆盖 > 专家默认 > 全局。
 *
 *   ① 会话里用户显式选过连接器 → 原样照用，专家声明不抢方向盘；
 *   ② 没选过但专家声明了 → 取 core 那几条（optional 默认关）；
 *   ③ 两者都没有 → 空数组＝不加限制，维持「全局装了就能用」的现状。
 *
 * 返回空数组含义是「不收窄」，不是「一个都不给」——调用方按 workbenchToolScope
 * 的既有语义处理（空 = 无限制）。
 */
export function resolveSessionConnectorIds(args: {
  sessionSelectedIds?: readonly string[];
  expertConnectors?: readonly ExpertConnector[];
}): string[] {
  const sessionSelected = (args.sessionSelectedIds || []).map((id) => id.trim()).filter(Boolean);
  if (sessionSelected.length > 0) return [...new Set(sessionSelected)];

  const core = (args.expertConnectors || [])
    .filter((connector) => connector.level === 'core')
    .map((connector) => connector.id);
  return [...new Set(core)];
}
