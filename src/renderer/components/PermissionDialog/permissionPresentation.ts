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
  const compactTarget = target ? basename(redactCredentialText(target)) : undefined;
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
