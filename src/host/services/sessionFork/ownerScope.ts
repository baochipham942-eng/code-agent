// ============================================================================
// Session fork owner scope — 台账 owner 口径的单一真源
// ============================================================================
//
// SessionHistoryAppService.importSessionFork 写 session_fork_portability_imports
// 用的 ownerScopeId，与外部历史批量导入（agentEngine 域 importRecentChats action）
// 预检台账的 ownerScopeId 必须逐字同值：两处口径漂移会让去重预检整批漏判，
// 重复导入直接穿透到 SYNC_ID_DIGEST_CONFLICT。谁要这口值，从这取，别再写第二份表达式。

import { LOCAL_SESSION_FORK_OWNER_SCOPE_ID } from '../../../shared/contract/sessionForkPortability';
import { getAuthService } from '../auth/authService';

/** 登录用户的 id；未登录回落本地 owner scope（与 importSessionFork 台账口径一致）。 */
export function currentSessionForkOwnerScopeId(): string {
  return getAuthService().getCurrentUser()?.id ?? LOCAL_SESSION_FORK_OWNER_SCOPE_ID;
}
