// ============================================================================
// inviteExpert —「去 TA 的会话」统一入口（原「请 TA 来」，Batch 3 E2 → N-NAMEDMATE 刀 1）
//
// 专家面板卡片 / quickPrompt / 专家详情页顶部动作共用：
// 先问宿主这位专家有没有已存在的专家主 thread（sessions.metadata.expertThread，
// SQL 判定，不靠前端遍历分页列表）——有就关覆盖层切过去续聊（bindAgentForSession
// 保持 per-session 缓存一致），没有才走新建链路：新建会话 → 绑定角色
// （bindAgentForSession，先落盘 per-session map 防 sync effect 竞态）→ 可选写入
// 开场 prompt（ChatView 的 pendingRoleChatSeed 通道自动发出，spawn 时按
// activeAgentId 走该角色）。引用条（quickPrompt）带 seed 时语义不变：续上已有
// thread 再以该句发起（刀 1 拍板）。
// ============================================================================

import { IPC_DOMAINS } from '@shared/ipc';
import { invokeDomain } from '../services/ipcService';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

export interface InviteExpertOptions {
  /** 开场消息（quickPrompt 点击时传入）；不传则只建绑定会话不发消息 */
  seed?: string;
  /** 会话标题；默认用角色展示名/roleId */
  title?: string;
}

async function inviteExpert(roleId: string, options?: InviteExpertOptions): Promise<void> {
  const app = useAppStore.getState();
  app.setShowSettings(false);
  app.setShowCapabilityHub(false);

  const session = await useSessionStore.getState().createSession(options?.title || roleId, {
    expertRoleId: roleId,
  });
  if (!session) return;

  app.bindAgentForSession(session.id, roleId);
  if (options?.seed) {
    app.setPendingRoleChatSeed(options.seed);
  }
}

/**
 * 「去 TA 的会话」：该专家已有主 thread 就续上（切到那条会话），没有才新建。
 * 查询失败时退回新建链路（与刀 0 之前的行为一致，可恢复；按钮不死）。
 */
export async function goToExpertThread(roleId: string, options?: InviteExpertOptions): Promise<void> {
  let sessionId: string | null;
  try {
    const result = await invokeDomain<{ sessionId: string | null }>(
      IPC_DOMAINS.SESSION,
      'findExpertThread',
      { roleId },
    );
    sessionId = typeof result?.sessionId === 'string' && result.sessionId.length > 0 ? result.sessionId : null;
  } catch {
    sessionId = null;
  }

  if (!sessionId) {
    await inviteExpert(roleId, options);
    return;
  }

  const app = useAppStore.getState();
  app.setShowSettings(false);
  app.setShowCapabilityHub(false);
  app.bindAgentForSession(sessionId, roleId);
  await useSessionStore.getState().switchSession(sessionId);
  if (options?.seed) {
    app.setPendingRoleChatSeed(options.seed);
  }
}
