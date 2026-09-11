import { AgentFailureCode, HostReasonCode, type ToolCall } from '@shared/contract';
import { redactCredentialText } from '@shared/security/secretPatterns';
import type { Translations } from '../i18n';
import { classifyToolName } from './humanizeToolStep';

type PreflightKind = 'question' | 'repair' | 'approvalUnavailable' | 'approvalRequired' | 'readRequired';

/**
 * 宿主给未送达提问写的占位符，锚在**开头**。
 * 生产里它后面还跟着问题列表与告诫（askUserQuestion.ts:48：
 * `[用户未响应 - CLI 模式无法交互]\n\n${formatted}\n\n⚠️ …`），所以不能整条匹配——
 * 我上一轮就是照着测试夹具写成了整条锚定，夹具过了、生产里一条都匹配不上。
 * 锚开头既排掉「用户自己答案里出现同样的字」，又认得真实形状。
 */
const UNDELIVERED_QUESTION_PLACEHOLDER = /^\s*\[用户未响应[^\]\n]*\]/;

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
  // 这一档必须排在 result.success 守卫之前：未送达的提问在传输层确实是 success（历史结果
  // 不可篡改），要靠它自己识别。但也正因为排在前面，判据必须紧——原先对 output 做的是
  // 无锚点子串匹配，用户在自由文本答案里写下「CLI 模式无法交互」这几个字，他自己那条
  // 已回答的提问就会被翻成 success:false：行首变红、显示「问题没有送达你」，而紧下方的
  // askUserRecord 还渲染着他的真实答案，同一块 UI 自相矛盾。
  // 改成只认两种：宿主挂的结构化 permissionDecision，或**整条 output 就是**宿主那句占位符。
  if (classifyToolName(tool.name) === 'askUser' && (
    (metadata?.permissionDecision === 'deny' && /没有可投递|不支持交互|no.*interaction/i.test(String(metadata?.permissionDecisionReason)))
    || UNDELIVERED_QUESTION_PLACEHOLDER.test(text)
  )) return 'question';
  if (result.success) return null;
  // 只认结构化的 artifactRepairGuard.blocked，不再对自由文本匹配「Artifact repair mode
  // is active」——那句话对 Bash 来说就是被执行程序自己的 stdout/stderr。在本仓库跑
  // `npx vitest run tests/renderer/components/` 这类命令，输出里就带着这句原文（夹具里有），
  // 命令真跑了、真 exit 1、可能已产生副作用，却会被渲染成「未执行 · 正在修复另一份成品」，
  // 真实失败原因被顶掉。这条旁路还是纯冗余：产出该短语的 host 路径都挂了结构化字段
  // （artifactRepairProjection.ts:387 就按 metadata.artifactRepairGuard.blocked 判定）。
  // blocked 这个字段是**重载**的：执行前拦下会挂它（toolExecutionEngine.ts:460/508），
  // 执行**之后**锚点失配也会补挂（toolResultLifecycle.ts:144），后者是真跑过的 Edit。
  // 只有后者带 editAnchorFailure，用它把两种情形分开——否则修复模式下一次 old_string
  // 对不上的 Edit 会被渲染成「未修改 · 这一步超出当前允许的修复范围」，把真实原因
  // （锚点对不上）用一句错误解释顶掉，组头还计成「1 个步骤未执行」。
  const repairGuard = metadata?.artifactRepairGuard as { blocked?: boolean; editAnchorFailure?: boolean } | undefined;
  if (repairGuard?.blocked && repairGuard.editAnchorFailure !== true) return 'repair';
  // hostReason is host-attached structured metadata (never parsed from program output); a loose
  // field read is deliberate — we only ever compare `.code` against the known enum below, so a
  // malformed/partial payload just fails to match rather than needing full schema validation.
  const hostCode = (metadata?.hostReason as { code?: string } | undefined)?.code;
  if (hostCode === HostReasonCode.PermissionDeniedNoApprovalUi) return 'approvalUnavailable';
  if (
    (hostCode && APPROVAL_REQUIRED_HOST_CODES.has(hostCode as HostReasonCode))
    || metadata?.failureCode === AgentFailureCode.PermissionDenied
  ) return 'approvalRequired';
  // write.ts:331 的孪生码 NOT_READ_FOR_OVERWRITE 同义，别只认 Edit 那一个。
  if (metadata?.code === 'NOT_READ' || metadata?.code === 'NOT_READ_FOR_OVERWRITE') return 'readRequired';
  return null;
}

const COMMAND_PREVIEW_MAX = 80;

/** 与 humanizeToolStep 的 takePreview 同口径：压空白、超长尾部截断。 */
function previewCommand(value: string): string | undefined {
  const trimmed = redactCredentialText(value.trim().replace(/\s+/g, ' '));
  if (!trimmed) return undefined;
  return trimmed.length <= COMMAND_PREVIEW_MAX ? trimmed : `${trimmed.slice(0, COMMAND_PREVIEW_MAX)}…`;
}

export function toolPreflightCopy(tool: Pick<ToolCall, 'name' | 'result'> & Partial<Pick<ToolCall, 'arguments'>>, t: Translations): { action: string; reason: string } | null {
  const kind = getToolPreflightKind(tool);
  if (!kind) return null;
  const c = t.deliveryExperience;
  if (kind === 'question') return { action: c.questionUnavailable, reason: c.questionReason };
  const category = classifyToolName(tool.name);
  const verb = category === 'write' ? c.notWritten : category === 'edit' ? c.notEdited : category === 'read' ? c.notRead : c.blocked;
  // 文件类给 basename，非文件类（Bash / Process / terminal_write…）给命令原文——
  // 否则连着几条命令被权限层拦下时，时间线上是数条一模一样的「未执行 · 需要人工确认」，
  // 用户分不清拦下的是哪条。origin/main 同一输入显示的是「运行命令 npm test 未成功」，
  // 命令原文在行内，不是只在 hover tooltip 里。
  const path = tool.arguments?.file_path ?? tool.arguments?.path;
  const command = tool.arguments?.command ?? tool.arguments?.input;
  const subject = typeof path === 'string'
    ? path.split(/[\\/]/).pop()
    : typeof command === 'string' ? previewCommand(command) : undefined;
  return { action: subject ? `${verb} · ${subject}` : verb,
    reason: kind === 'repair' ? c.repairReason : c[kind] };
}
