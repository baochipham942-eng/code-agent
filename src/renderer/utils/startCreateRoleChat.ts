// ============================================================================
// startCreateRoleChat — 对话式建角色入口的统一触发器（role-creation-flow §7）
//
// 设置页 RolesTab 的"+ 新建角色"按钮与状态栏 AgentSwitcher 的"＋ 新建角色"
// 共用这条路径：关闭设置 → 起一个新会话 → 写入待发种子消息。
// ChatView 在新会话就绪后消费 pendingRoleChatSeed，自动发出可见的种子消息，
// 触发 create-role 内置 skill（角色架构师访谈 → 起草 → 确认卡）。
//
// 种子用**确定性 slash 调用** `/create-role`（而非自然语言）：conversationRuntime 的
// resolveSkillInvocation 命中 DIRECT_SLASH_PATTERN（置信 1），强制进入 create-role 上下文，
// propose_role 才会被预加载并可见。自然语言种子靠模型自选 Skill: 工具不可靠（与 edit-role
// 同根因，见 [[feedback_conversational_skill_entry_needs_deterministic_slash_seed]]）。
// ============================================================================

import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

/** 确定性 slash 种子：命中 create-role skill，强制进入其上下文（propose_role 才可见） */
export const CREATE_ROLE_SEED = '/create-role';

export async function startCreateRoleChat(): Promise<void> {
  const app = useAppStore.getState();
  // 从设置页触发时先关闭设置弹层，回到聊天
  app.setShowSettings(false);

  const session = await useSessionStore.getState().createSession('新建角色');
  if (!session) return;

  // 新会话已成为 currentSessionId，写入待发种子消息，由 ChatView 自动发出
  app.setPendingRoleChatSeed(CREATE_ROLE_SEED);
}
