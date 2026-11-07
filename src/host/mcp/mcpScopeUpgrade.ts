// ============================================================================
// mcpScopeUpgrade —— 「重新授权」补授权时把缺的 scope 并进授权 URL
// ============================================================================
// SDK 重连走 401 挑战：scope 取自挑战 / 资源元数据，不含上次 403 声明缺的那个，
// 所以光 invalidate tokens + reconnect 只会再请求旧 scope。这里记一条一次性提示，
// 在重定向去授权页前把缺的 scope 并进 authUrl 的 scope 参数（state/PKCE 不受影响）。
// ============================================================================

const pendingHints = new Map<string, string>();

export function setMcpScopeUpgradeHint(serverIdentity: string, requiredScope: string | undefined): void {
  const scope = requiredScope?.trim();
  if (scope) pendingHints.set(serverIdentity, scope);
  else pendingHints.delete(serverIdentity);
}

/** 取走（一次性）并合并到授权 URL；无提示时原样返回。 */
export function applyMcpScopeUpgradeHint(serverIdentity: string, authUrl: URL): URL {
  const hint = pendingHints.get(serverIdentity);
  if (!hint) return authUrl;
  pendingHints.delete(serverIdentity);
  const merged = new Set<string>();
  for (const token of `${authUrl.searchParams.get('scope') ?? ''} ${hint}`.split(/\s+/)) {
    if (token) merged.add(token);
  }
  const upgraded = new URL(authUrl.toString());
  upgraded.searchParams.set('scope', [...merged].join(' '));
  return upgraded;
}
