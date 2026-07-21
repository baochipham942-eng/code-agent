// ============================================================================
// activeAgentId per-session 持久化（S3 收敛，从 appStore 下沉）
// legacy 全局单值 key 是跨会话残留路由的根源，读到即丢弃（旧值无法归属到会话）；
// 新 key 存 sessionId → agentId map。
// ============================================================================

const LEGACY_ACTIVE_AGENT_STORAGE_KEY = 'app:activeAgentId';
const ACTIVE_AGENT_SESSION_MAP_KEY = 'app:activeAgentIdBySession';

export function readActiveAgentSessionMap(): Record<string, string> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(ACTIVE_AGENT_SESSION_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

export function writeActiveAgentSessionMap(map: Record<string, string>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ACTIVE_AGENT_SESSION_MAP_KEY, JSON.stringify(map));
  } catch {
    // localStorage 在隐私模式下可能不可用——降级为纯内存状态
  }
}

export function dropLegacyActiveAgentKey(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(LEGACY_ACTIVE_AGENT_STORAGE_KEY);
  } catch {
    // ignore
  }
}
