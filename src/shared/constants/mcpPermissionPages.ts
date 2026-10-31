// ============================================================================
// 连接器「官方权限页」链接表（N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE）
// ============================================================================
// connectorId（与 mcpCatalog 的 id 同口径）→ 已核实的服务方官方权限管理页 URL。
// 默认空：只有证据档里引用了服务方官方公开页面原文、且该页面明确指向权限管理入口的条目才能加入。
// 查不到就不要写——卡片对未收录的连接器只给「重新授权」按钮，不展示链接，更不能编造。
// ============================================================================

export const MCP_PERMISSION_PAGE_URLS: Readonly<Record<string, string>> = {};

export function getMcpPermissionPageUrl(connectorId: string, table: Readonly<Record<string, string>> = MCP_PERMISSION_PAGE_URLS): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, connectorId) ? table[connectorId] : undefined;
}
