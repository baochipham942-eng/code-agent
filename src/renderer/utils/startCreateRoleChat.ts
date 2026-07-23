// ============================================================================
// startCreateRoleChat — 对话式建角色入口的统一触发器（role-creation-flow §7）
//
// 能力中心 · 专家的"+ 新建角色"按钮与状态栏 AgentSwitcher 的"＋ 新建角色"
// 共用这条路径：关闭设置 → 起一个新会话 → 打开就地确认卡。
//
// 种子用**确定性 slash 调用** `/create-role`（而非自然语言）：conversationRuntime 的
// resolveSkillInvocation 命中 DIRECT_SLASH_PATTERN（置信 1），强制进入 create-role 上下文，
// propose_role 才会被预加载并可见。自然语言种子靠模型自选 Skill: 工具不可靠（与 edit-role
// 同根因，见 [[feedback_conversational_skill_entry_needs_deterministic_slash_seed]]）。
// ============================================================================

import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

export async function startCreateRoleChat(): Promise<void> {
  const app = useAppStore.getState();
  // 从设置页触发时先关闭设置弹层，回到聊天
  app.setShowSettings(false);

  const session = await useSessionStore.getState().createSession('新建角色');
  if (!session) return;

  window.dispatchEvent(new CustomEvent('app:openSeedComposer', { detail: { kind: 'role' } }));
}
