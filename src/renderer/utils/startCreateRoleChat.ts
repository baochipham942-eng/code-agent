// ============================================================================
// startCreateRoleChat — 对话式建角色入口的统一触发器（role-creation-flow §7）
//
// 设置页 RolesTab 的"+ 新建角色"按钮与状态栏 AgentSwitcher 的"＋ 新建角色"
// 共用这条路径：关闭设置 → 起一个新会话 → 写入待发种子消息。
// ChatView 在新会话就绪后消费 pendingRoleChatSeed，自动发出可见的种子消息，
// 触发 create-role 内置 skill（角色架构师访谈 → 起草 → 确认卡）。
// ============================================================================

import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

/** 可见种子消息文案（owner 选定：发可见种子消息，过程透明） */
export const CREATE_ROLE_SEED = '我想新建一个角色';

export async function startCreateRoleChat(): Promise<void> {
  const app = useAppStore.getState();
  // 从设置页触发时先关闭设置弹层，回到聊天
  app.setShowSettings(false);

  const session = await useSessionStore.getState().createSession('新建角色');
  if (!session) return;

  // 新会话已成为 currentSessionId，写入待发种子消息，由 ChatView 自动发出
  app.setPendingRoleChatSeed(CREATE_ROLE_SEED);
}
