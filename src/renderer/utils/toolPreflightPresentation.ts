import { AgentFailureCode, HostReasonCode, type ToolCall } from '@shared/contract';
import type { Translations } from '../i18n';
import { classifyToolName } from './humanizeToolStep';

type PreflightKind = 'question' | 'repair' | 'approvalUnavailable' | 'approvalRequired' | 'readRequired';

// Denied-for-approval-reasons host codes: the operation reached the permission layer and was
// rejected there (classifier/policy/hard-gate/timeout/cancel), as opposed to no approval UI
// existing at all (PermissionDeniedNoApprovalUi, handled separately below).
const APPROVAL_REQUIRED_HOST_CODES: ReadonlySet<HostReasonCode> = new Set([
  HostReasonCode.PermissionClassifierDenied,
  HostReasonCode.PermissionHighRiskActionBlocked,
  HostReasonCode.PermissionUnregisteredActionBlocked,
  HostReasonCode.PermissionCommandAnalysisFailed,
  HostReasonCode.PermissionClassifierFailed,
  HostReasonCode.PermissionDeniedByUser,
  HostReasonCode.PermissionDeniedTimeout,
  HostReasonCode.PermissionDeniedCancelled,
  HostReasonCode.PermissionDeniedFailClosed,
  HostReasonCode.PermissionDeniedScripted,
]);

/**
 * Presentation only: historical transport success does not mean a question reached the user.
 *
 * Evidence discipline: `result.error`/`result.output` for a failed tool can be the STDOUT/STDERR
 * of whatever program the tool ran (Bash chief among them) — free-text matching against it is
 * unbounded and will misclassify an executed-but-failed command as "not executed" whenever the
 * program's own output happens to contain approval/permission-shaped words (e.g. `gh pr merge`
 * hitting branch protection: "requires approval from a reviewer", still a real exit≠0 run).
 * approvalRequired/readRequired below therefore only trust structured evidence the host itself
 * attached (`metadata.hostReason.code` / `metadata.failureCode` / `metadata.code`), never the
 * free-text error/output.
 */
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
  // 只认结构化的 artifactRepairGuard.blocked，不再对自由文本匹配「Artifact repair mode
  // is active」——那句话对 Bash 来说就是被执行程序自己的 stdout/stderr。在本仓库跑
  // `npx vitest run tests/renderer/components/` 这类命令，输出里就带着这句原文（夹具里有），
  // 命令真跑了、真 exit 1、可能已产生副作用，却会被渲染成「未执行 · 正在修复另一份成品」，
  // 真实失败原因被顶掉。这条旁路还是纯冗余：产出该短语的 host 路径都挂了结构化字段
  // （artifactRepairProjection.ts:387 就按 metadata.artifactRepairGuard.blocked 判定）。
  if ((metadata?.artifactRepairGuard as { blocked?: boolean } | undefined)?.blocked) return 'repair';
  // hostReason is host-attached structured metadata (never parsed from program output); a loose
  // field read is deliberate — we only ever compare `.code` against the known enum below, so a
  // malformed/partial payload just fails to match rather than needing full schema validation.
  const hostCode = (metadata?.hostReason as { code?: string } | undefined)?.code;
  if (hostCode === HostReasonCode.PermissionDeniedNoApprovalUi) return 'approvalUnavailable';
  if (
    (hostCode && APPROVAL_REQUIRED_HOST_CODES.has(hostCode as HostReasonCode))
    || metadata?.failureCode === AgentFailureCode.PermissionDenied
  ) return 'approvalRequired';
  if (metadata?.code === 'NOT_READ') return 'readRequired';
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
