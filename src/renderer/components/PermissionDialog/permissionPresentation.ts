import type { Translations } from '../../hooks/useI18n';
import type { DecisionCardViewMode } from '../DecisionCard';
import type { PermissionRequest } from './types';
import { formatFilePath } from './utils';
import { redactCredentialText } from '@shared/security/secretPatterns';

function fileTarget(request: PermissionRequest): string | undefined {
  return request.details.filePath || request.details.path;
}

function basename(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/u, '');
  return normalized.split('/').pop() || target;
}

/**
 * /dev/null 的 basename 是 "null"，进标题会读成空值或普通文件名。
 * 设备节点与 DOS 保留名用完整路径展示，不当文件名截断。
 */
/**
 * 这里**故意没有**「是不是设备文件」的判定。
 *
 * 审批卡拿到的是 host **未解析**的原始 file_path，渲染层无从知道它最终指向什么：
 * ai-review #1692 连着四轮各造出一个反例——`/dev/shm/report.md`（前缀）、POSIX 上名为
 * `NUL` 的文件（裸保留名）、`\dev\null`（反斜杠归一化）、Windows 上 `/dev/null` 解析成
 * `C:\dev\null`（平台差异）。每补一条判据就多一种构造法，且每一次判错的代价都是
 * **把「可能覆盖现有内容」的警告从一个真会被覆盖的文件上摘掉**。
 *
 * 所以按「穷举转结构性方案」收口：本层不再声称设备文件，一律保留覆盖警告
 * （写 /dev/null 时多一句无害的提示）。真要区分，得在 host 侧拿解析后的路径 + stat
 * 判断再传下来 —— 已开 N-APPROVAL-DEVICE-CONSEQUENCE-HOST。
 */

/** 标题是否保留完整路径。比设备白名单宽是**有意的**：多显示路径无害，少显示才误导。 */
function isDeviceOrSpecialPath(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/u, '');
  const lower = normalized.toLowerCase();
  if (lower === '/dev' || lower.startsWith('/dev/')) return true;
  if (lower === '/proc' || lower.startsWith('/proc/')) return true;
  if (lower === '/private/dev' || lower.startsWith('/private/dev/')) return true;
  if (/^(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i.test(normalized)) return true;
  if (/^\/\/\.\/(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i.test(normalized)) return true;
  return false;
}

function compactFileTarget(target: string): string {
  const redacted = redactCredentialText(target);
  return isDeviceOrSpecialPath(redacted) ? redacted : basename(redacted);
}

function isOutsideWorkspace(request: PermissionRequest): boolean {
  return request.boundary?.id === 'file.external_read' || request.boundary?.id === 'file.external_write';
}

function isDeletionRequest(request: PermissionRequest): boolean {
  const flags = request.details.commandSecurityFlags ?? [];
  return request.type === 'file_delete'
    || flags.some((flag) => /delete|sudo_rm/u.test(flag))
    || /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/u.test(request.details.command ?? '');
}

/**
 * 安全默认的唯一判据：删除/不可逆、工作区外写入、显式警告，以及高风险命令
 * 都默认突出拒绝动作。展示层只消费结论，不再各自拼一套风险条件。
 */
export function isSafeDefaultDeny(request: PermissionRequest): boolean {
  const commandRisk = request.details.commandRiskLevel;
  return isDeletionRequest(request)
    || request.boundary?.id === 'file.external_write'
    || request.dangerLevel === 'warning'
    || request.dangerLevel === 'danger'
    || commandRisk === 'high'
    || commandRisk === 'critical';
}

export function defaultPermissionViewMode(request: PermissionRequest): DecisionCardViewMode {
  if (request.rawArgs || isOutsideWorkspace(request) || isSafeDefaultDeny(request)) return 'expanded';
  return request.type === 'file_read' || request.type === 'file_write' || request.type === 'file_edit'
    ? 'compact'
    : 'expanded';
}

export function permissionSummary(request: PermissionRequest, t: Translations): string {
  const p = t.decisionCard.permission;
  const target = fileTarget(request);
  const compactTarget = target ? compactFileTarget(target) : undefined;
  const qualifier = isOutsideWorkspace(request) ? `（${p.workspaceOutside}）` : '';
  switch (request.type) {
    case 'file_read':
      return compactTarget ? p.questionFileRead.replace('{target}', `${compactTarget}${qualifier}`) : p.questionFallback;
    case 'file_write':
      return compactTarget ? p.questionFileWrite.replace('{target}', `${compactTarget}${qualifier}`) : p.questionFallback;
    case 'file_edit':
      return compactTarget ? p.questionFileEdit.replace('{target}', `${compactTarget}${qualifier}`) : p.questionFallback;
    case 'file_delete':
      return compactTarget ? p.questionFileDelete.replace('{target}', `${compactTarget}${qualifier}`) : p.questionFallback;
    case 'command':
      return p.questionCommand;
    case 'dangerous_command':
      return p.questionCommand;
    case 'network':
      return request.details.server || request.details.toolName
        ? p.questionMcpGeneric
        : request.details.url
          ? p.questionNetwork.replace('{target}', redactCredentialText(request.details.url))
          : p.questionFallback;
    case 'mcp':
      return p.questionMcpGeneric;
    default:
      return p.questionFallback;
  }
}

function fileCountText(count: number | undefined, t: Translations): string {
  if (count === undefined) return '';
  return t.decisionCard.permission.fileCount.replace('{count}', String(count));
}

export function permissionConsequence(request: PermissionRequest, t: Translations): string | undefined {
  const p = t.decisionCard.permission;
  const commandDeleteTarget = request.details.command?.match(/\brm\s+(?:(?:-[^\s]+|--[^\s]+)\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/u);
  const target = request.details.affectedPath
    || fileTarget(request)
    || commandDeleteTarget?.[1]
    || commandDeleteTarget?.[2]
    || commandDeleteTarget?.[3];
  const safeTarget = target ? formatFilePath(redactCredentialText(target)) : undefined;
  const count = request.details.affectedFileCount ?? (safeTarget ? 1 : undefined);
  const deletion = isDeletionRequest(request);

  if (deletion) {
    return p.consequenceDelete
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(count, t));
  }
  if (isOutsideWorkspace(request)) {
    return p.consequenceOutside
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(count, t));
  }
  if (request.type === 'network' || request.type === 'mcp') {
    const endpoint = request.details.url
      || [request.details.server, request.details.toolName].filter(Boolean).join(' / ')
      || p.externalServiceFallback;
    return p.consequenceNetwork.replace('{target}', redactCredentialText(endpoint));
  }
  if (request.type === 'file_write' || request.type === 'file_edit') {
    return p.consequenceWrite
      .replace('{target}', safeTarget ?? p.targetFallback)
      .replace('{count}', fileCountText(count, t));
  }
  if (request.type === 'command' || request.type === 'dangerous_command') {
    const risk = request.details.commandRiskLevel ?? (request.dangerLevel === 'danger' ? 'high' : 'medium');
    if (risk === 'critical' || risk === 'high') return p.consequenceHighRiskCommand;
    const classifierRules = request.decisionTrace?.steps.map((step) => step.rule) ?? [];
    if (classifierRules.includes('B1: sensitive_credential_read')) return p.consequenceCredentialReadCommand;
    if (classifierRules.includes('B1: git_remote_or_credential_write')) return p.consequenceGitRemoteWriteCommand;
    return risk === 'unknown'
      ? p.consequenceUnknownRiskCommand
      : p.consequenceRiskCommand;
  }
  return undefined;
}
