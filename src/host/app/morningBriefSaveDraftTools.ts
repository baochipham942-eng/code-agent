import { isMorningBriefSaveDraftReply } from './sessionCommandCenterBrain';

// 存草稿轮、角色又没开邮件（未声明 mail/mail_draft）时整批撤下的工具名（FB-726）：
// - mail 连接器三件套：没有邮件权限的角色不该看到任何发信面——此前只撤 mail_draft，
//   mail_send 漏撤，聊天里弹出「发送这封邮件？」审批卡，误点就真发了；
// - delegate_task：后台任务自带完整工具面，会绕回 Bash/osascript 真发信；
// - Bash：shell 执行工具，osascript 调 Mail 的直接旁路。
// 组成核过（getTextForegroundToolNamesForPrompt：allowInTextForeground 基面 + 存草稿
// mail_draft + 连接器意图扩展）：shell/terminal 执行名里只有 Bash 这一个可能出现在
// 组成里（当前基面未声明它，撤它是防御性的）；Grep 是只读搜索不在撤单之列。
const SAVE_DRAFT_NO_MAIL_REMOVE = new Set(['mail', 'mail_send', 'mail_draft', 'delegate_task', 'Bash']);

export function applyMorningBriefSaveDraftRoleTools(
  prompt: string,
  allowedToolNames: string[] | undefined,
  roleTools: readonly string[] | undefined,
): string[] | undefined {
  if (!allowedToolNames || !isMorningBriefSaveDraftReply(prompt) || !roleTools?.length) return allowedToolNames;
  if (roleTools.some((tool) => tool === 'mail' || tool === 'mail_draft')) return allowedToolNames;
  return allowedToolNames.filter((tool) => !SAVE_DRAFT_NO_MAIL_REMOVE.has(tool));
}
