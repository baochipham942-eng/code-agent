import type { SessionWithMeta } from '../stores/sessionStore';

export type SessionRecoveryHintKind =
  | 'workspace'
  | 'artifact'
  | 'replay'
  | 'branch'
  | 'pr'
  | 'tool'
  | 'skill'
  | 'connector'
  | 'mcp';

export interface SessionRecoveryHint {
  kind: SessionRecoveryHintKind;
  label: string;
  title: string;
}

export interface SessionRecoveryHintOptions {
  hasReplay?: boolean;
  canOpenReplay?: boolean;
}

function truncateHint(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function pushUniqueHint(
  hints: SessionRecoveryHint[],
  hint: SessionRecoveryHint,
): void {
  if (hints.some((item) => item.kind === hint.kind && item.label === hint.label)) {
    return;
  }
  hints.push(hint);
}

function formatWorkspaceLabel(session: SessionWithMeta): string | null {
  const label = session.workbenchSnapshot?.workspaceLabel?.trim();
  if (label) {
    return label;
  }
  const directory = session.workingDirectory?.trim();
  if (!directory) {
    return null;
  }
  return directory.split(/[\\/]/).filter(Boolean).pop() || directory;
}

function formatBranchLabel(branch: string): string {
  const parts = branch.split('/').filter(Boolean);
  return parts[parts.length - 1] || branch;
}

export function hasSessionDeliverySignals(
  session: SessionWithMeta,
  options: SessionRecoveryHintOptions = {},
): boolean {
  return session.workbenchSnapshot?.primarySurface === 'workspace'
    || Boolean(options.hasReplay)
    || Boolean(session.workbenchSnapshot?.recentToolNames.some((toolName) =>
      /write|edit|artifact|notebook/i.test(toolName)
    ));
}

export function buildSessionRecoveryHints(
  session: SessionWithMeta,
): SessionRecoveryHint[] {
  const hints: SessionRecoveryHint[] = [];
  const workspaceLabel = formatWorkspaceLabel(session);
  if (workspaceLabel) {
    pushUniqueHint(hints, {
      kind: 'workspace',
      label: truncateHint(workspaceLabel, 18),
      title: session.workingDirectory || workspaceLabel,
    });
  }

  if (session.gitBranch?.trim()) {
    const branch = session.gitBranch.trim();
    pushUniqueHint(hints, {
      kind: 'branch',
      label: truncateHint(formatBranchLabel(branch), 18),
      title: `Git branch: ${branch}`,
    });
  }

  if (session.prLink) {
    const label = `PR #${session.prLink.number}`;
    pushUniqueHint(hints, {
      kind: 'pr',
      label,
      title: session.prLink.title ? `${label} · ${session.prLink.title}` : label,
    });
  }

  // 简化侧栏：会话项只保留"在哪/哪条分支/哪个 PR"这类定位上下文。
  // 之前还会堆 Replay / 产物 / 最近工具(MemoryRead/WebSearch) / N Skill / N Connector / N MCP
  // 一堆引擎内幕 chip，既和右侧操作按钮(Eye=Replay、产物按钮)重复，又把列表挤复杂——全部去掉。
  return hints.slice(0, 3);
}
