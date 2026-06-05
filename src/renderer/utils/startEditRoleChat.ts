// ============================================================================
// startEditRoleChat — 对话式改已有角色入口的触发器（role-edit-flow，对照 startCreateRoleChat）
//
// 设置页 RolesTab 角色详情页的"对话式修改"按钮触发：关闭设置 → 起一个新会话 →
// 写入待发种子消息。ChatView 在新会话就绪后消费 pendingRoleChatSeed，自动发出可见的
// 种子消息，触发 edit-role 内置 skill（读现有定义 → 访谈改什么 → propose_role 带
// editingRoleId 重起草 → 确认卡）。
//
// 关键：种子必须是**确定性 slash 调用** `/edit-role <roleId>`，而不是自然语言。
// conversationRuntime 对每条用户消息跑 resolveSkillInvocation：`/edit-role` 命中
// DIRECT_SLASH_PATTERN（置信 1），强制把模型带进 edit-role 上下文 + 注入 skill prompt +
// 把 allowedTools（含 propose_role）放进 preApprovedTools/toolBoundary。靠自然语言让模型
// 自己选 Skill: 工具不可靠（验收实证 mimo 不进上下文 → propose_role 不可见 → 无确认卡）。
// roleId 作为 slash 参数透传，skill prompt 经 "User provided arguments" 拿到要改的角色名。
// ============================================================================

import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

/**
 * 确定性 slash 种子：`/edit-role <roleId>`。
 * 命中 skillInvocationResolver 的 DIRECT_SLASH_PATTERN，强制进入 edit-role skill 上下文，
 * roleId 作为 args 传给 skill（不依赖模型从自然语言里猜该用哪个 skill）。
 */
export function buildEditRoleSeed(roleId: string): string {
  return `/edit-role ${roleId}`;
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
