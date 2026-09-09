import type { ToolCall } from '@shared/contract';
import type { Translations } from '../i18n';
import { classifyToolName } from './humanizeToolStep';

type PreflightKind = 'question' | 'repair' | 'approvalUnavailable' | 'approvalRequired' | 'readRequired';

/** Presentation only: historical transport success does not mean a question reached the user. */
export function getToolPreflightKind(tool: Pick<ToolCall, 'name' | 'result'>): PreflightKind | null {
  const result = tool.result;
  if (!result) return null;
  const metadata = result.metadata;
  const text = result.error || (typeof result.output === 'string' ? result.output : '');
  if (classifyToolName(tool.name) === 'askUser' && (
    (metadata?.permissionDecision === 'deny' && /没有可投递|不支持交互|no.*interaction/i.test(String(metadata?.permissionDecisionReason)))
    || /CLI 模式无法交互/.test(text)
  )) return 'question';
  if (result.success) return null;
  if ((metadata?.artifactRepairGuard as { blocked?: boolean } | undefined)?.blocked || /Artifact repair mode is active/i.test(text)) return 'repair';
  const hostCode = (metadata?.hostReason as { code?: string } | undefined)?.code;
  if (hostCode === 'PERMISSION_DENIED_NO_APPROVAL_UI') return 'approvalUnavailable';
  if (/未获自动批准|auto 档不放行|auto.*(?:denied|拒绝)|requires? (?:manual |human )?(?:approval|confirmation)/i.test(text)) return 'approvalRequired';
  if (metadata?.code === 'NOT_READ' || /\bNOT_READ\b|must (?:first )?read|read.*before (?:editing|modifying)/i.test(text)) return 'readRequired';
  return null;
}

export function toolPreflightCopy(tool: Pick<ToolCall, 'name' | 'result'> & Partial<Pick<ToolCall, 'arguments'>>, t: Translations): { action: string; reason: string } | null {
  const kind = getToolPreflightKind(tool);
  if (!kind) return null;
  const c = t.deliveryExperience;
  if (kind === 'question') return { action: c.questionUnavailable, reason: c.questionReason };
  const category = classifyToolName(tool.name);
  const verb = category === 'write' ? c.notWritten : category === 'edit' ? c.notEdited : category === 'read' ? c.notRead : c.blocked;
  const path = tool.arguments?.file_path ?? tool.arguments?.path;
  const subject = typeof path === 'string' ? path.split(/[\\/]/).pop() : undefined;
  return { action: subject ? `${verb} · ${subject}` : verb,
    reason: kind === 'repair' ? c.repairReason : c[kind] };
}
