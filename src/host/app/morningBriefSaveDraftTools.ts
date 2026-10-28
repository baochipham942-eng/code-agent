import { isMorningBriefSaveDraftReply } from './sessionCommandCenterBrain';

export function applyMorningBriefSaveDraftRoleTools(
  prompt: string,
  allowedToolNames: string[] | undefined,
  roleTools: readonly string[] | undefined,
): string[] | undefined {
  if (!allowedToolNames || !isMorningBriefSaveDraftReply(prompt) || !roleTools?.length) return allowedToolNames;
  if (roleTools.some((tool) => tool === 'mail' || tool === 'mail_draft')) return allowedToolNames;
  return allowedToolNames.filter((tool) => tool !== 'mail_draft');
}
