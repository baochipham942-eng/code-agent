// ============================================================================
// inviteExpert —「请 TA 来」统一入口（Batch 3 E2）
//
// 专家面板卡片 / quickPrompt / 侧栏最近专家条共用：
// 关闭覆盖层 → 新建会话 → 把角色绑到新会话（bindAgentForSession，先落盘
// per-session map 防 sync effect 竞态）→ 可选写入开场 prompt（ChatView 的
// pendingRoleChatSeed 通道自动发出，spawn 时按 activeAgentId 走该角色）。
// ============================================================================

import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

export interface InviteExpertOptions {
  /** 开场消息（quickPrompt 点击时传入）；不传则只建绑定会话不发消息 */
  seed?: string;
  /** 会话标题；默认用角色展示名/roleId */
  title?: string;
}

export async function inviteExpert(roleId: string, options?: InviteExpertOptions): Promise<void> {
  const app = useAppStore.getState();
  app.setShowSettings(false);
  app.setShowCapabilityHub(false);

  const session = await useSessionStore.getState().createSession(options?.title || roleId);
  if (!session) return;

  app.bindAgentForSession(session.id, roleId);
  if (options?.seed) {
    app.setPendingRoleChatSeed(options.seed);
  }
}
