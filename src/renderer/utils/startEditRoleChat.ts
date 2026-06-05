// ============================================================================
// startEditRoleChat — 对话式改已有角色入口的触发器（role-edit-flow，对照 startCreateRoleChat）
//
// 设置页 RolesTab 角色详情页的"对话式修改"按钮触发：关闭设置 → 起一个新会话 →
// 写入待发种子消息（点名要改哪个角色）。ChatView 在新会话就绪后消费 pendingRoleChatSeed，
// 自动发出可见的种子消息，触发 edit-role 内置 skill（读现有定义 → 访谈改什么 →
// propose_role 带 editingRoleId 重起草 → 确认卡）。
// ============================================================================

import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

/** 可见种子消息文案：点名被修改的角色，让 edit-role skill 据此 read_file 现有定义 */
export function buildEditRoleSeed(roleId: string): string {
  return `我想修改「${roleId}」这个角色`;
}

export async function startEditRoleChat(roleId: string): Promise<void> {
  const trimmed = roleId?.trim();
  if (!trimmed) return;

  const app = useAppStore.getState();
  // 从设置页触发，先关闭设置弹层回到聊天
  app.setShowSettings(false);

  const session = await useSessionStore.getState().createSession(`修改角色：${trimmed}`);
  if (!session) return;

  // 新会话已成为 currentSessionId，写入待发种子消息，由 ChatView 自动发出
  app.setPendingRoleChatSeed(buildEditRoleSeed(trimmed));
}
