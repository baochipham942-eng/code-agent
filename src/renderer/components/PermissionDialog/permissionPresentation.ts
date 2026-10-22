import type { Translations } from '../../hooks/useI18n';
import type { Language } from '../../i18n';
import type { DecisionCardViewMode } from '../DecisionCard';
import type { PermissionRequest } from './types';
import { formatFilePath, isDangerousCommand } from './utils';
import { redactCredentialText } from '@shared/security/secretPatterns';
import { PermissionRequestReason } from '@shared/contract';
import { isSandboxEscalation } from './sandboxEscalationPresentation';

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
 *
 * 标题是否保留完整路径。比设备白名单宽是**有意的**：多显示路径无害，少显示才误导。
 * 覆盖警告不看这条——只看 host 下发的 `details.targetKind`。
 */
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

/**
 * 卡片「危险红卡」判据的请求形状部分（PermissionCard 的 isDangerous 去掉 editable
 * 与 request-null 两个卡片态）。后果行的按应用抑制必须与标题/正文用同一把尺：
 * 两处各拼一套条件迟早漂移回「标题说应用、后果行说命令」。
 */
export function isDangerousRequestShape(request: PermissionRequest): boolean {
  return request.dangerLevel === 'danger'
    || request.type === 'dangerous_command'
    || (request.type === 'command' && isDangerousCommand(request.details.command));
}

export function defaultPermissionViewMode(request: PermissionRequest): DecisionCardViewMode {
  if (request.rawArgs || isOutsideWorkspace(request) || isSafeDefaultDeny(request)) return 'expanded';
  return request.type === 'file_read' || request.type === 'file_write' || request.type === 'file_edit'
    ? 'compact'
    : 'expanded';
}

export function permissionSummary(request: PermissionRequest, t: Translations, language: Language = 'zh'): string {
  const p = t.decisionCard.permission;
  const target = fileTarget(request);
  const compactTarget = target ? compactFileTarget(target) : undefined;
  const qualifier = isOutsideWorkspace(request) ? `（${p.workspaceOutside}）` : '';
  if (
    request.reasonCode === PermissionRequestReason.UncertainWriteTargetWithPathDeny
    && !isDeletionRequest(request)
  ) {
    return p.questionUncertainWriteTarget;
  }
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
    case 'network': {
      // N-HTTPREQ-CONNECTOR-CARD-DISCLOSE：连接器令牌写不是普通「访问 URL」——请求会以
      // 用户已连接应用的身份发出，问句必须点名连接器与「以你的身份」，URL 详情交给披露块。
      const connectorName = request.details.connectorTokenAttached === true && request.boundary?.connectorName
        ? (language === 'en' ? request.boundary.connectorNameEn ?? request.boundary.connectorName : request.boundary.connectorName)
        : undefined;
      if (connectorName) {
        return p.questionConnectorWrite.replace('{connector}', connectorName);
      }
      return request.details.server || request.details.toolName
        ? p.questionMcpGeneric
        : request.details.url
          ? p.questionNetwork.replace('{target}', redactCredentialText(request.details.url))
          : p.questionFallback;
    }
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
  // 沙盒放宽卡的问句已经说明放开哪一个文件或目录，不再叠命令后果行。
  if (isSandboxEscalation(request)) return undefined;
  // 按应用授权卡（appGrantCard && !isDangerous，判据与 PermissionCard 同源）问的是
  // 「要不要让 Neo 操作这个应用」，命令风险后果行会把刚统一的口径撕回去：标题与
  // 正文都说应用，后果行回头说命令。该卡不渲染命令后果行——问题句已把授权语义说尽。
  if (request.details.targetApp?.name && request.forceConfirm !== true && !isDangerousRequestShape(request)) {
    return undefined;
  }
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
  if (
    request.details.targetKind === 'device'
    && (request.type === 'file_write' || request.type === 'file_edit')
  ) {
    // Append 直写穿透：内容送达设备、节点保留；其余写类工具是原子替换，节点本身被换下。
    if (request.tool === 'Append') {
      return p.consequenceDeviceAppend.replace('{target}', safeTarget ?? p.targetFallback);
    }
    const copy = isOutsideWorkspace(request) ? p.consequenceDeviceOutside : p.consequenceDevice;
    return copy.replace('{target}', safeTarget ?? p.targetFallback);
  }
  if (request.reasonCode === PermissionRequestReason.UncertainWriteTargetWithPathDeny) {
    return p.consequenceUncertainWriteTarget;
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
