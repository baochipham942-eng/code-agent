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
  options: SessionRecoveryHintOptions = {},
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

  if (options.hasReplay) {
    pushUniqueHint(hints, {
      kind: 'replay',
      label: 'Replay',
      title: options.canOpenReplay === false
        ? '这个会话有 Workflow / Replay 证据，结构化 Replay 仅管理员可打开'
        : '打开这个会话的 Workflow / Replay 证据',
    });
  }

  if (hasSessionDeliverySignals(session)) {
    pushUniqueHint(hints, {
      kind: 'artifact',
      label: '产物',
      title: '打开这个会话的产物与资产',
    });
  }

  const recentToolName = session.workbenchSnapshot?.recentToolNames
    .map((name) => name.trim())
    .find(Boolean);
  if (recentToolName) {
    pushUniqueHint(hints, {
      kind: 'tool',
      label: truncateHint(recentToolName, 14),
      title: `最近工具：${recentToolName}`,
    });
  }

  const skillCount = session.workbenchSnapshot?.skillIds?.length ?? 0;
  if (skillCount > 0) {
    pushUniqueHint(hints, {
      kind: 'skill',
      label: `${skillCount} Skill`,
      title: `已选择 ${skillCount} 个 Skill`,
    });
  }

  const connectorCount = session.workbenchSnapshot?.connectorIds?.length ?? 0;
  if (connectorCount > 0) {
    pushUniqueHint(hints, {
      kind: 'connector',
      label: `${connectorCount} Connector`,
      title: `已选择 ${connectorCount} 个 Connector`,
    });
  }

  const mcpCount = session.workbenchSnapshot?.mcpServerIds?.length ?? 0;
  if (mcpCount > 0) {
    pushUniqueHint(hints, {
      kind: 'mcp',
      label: `${mcpCount} MCP`,
      title: `已选择 ${mcpCount} 个 MCP server`,
    });
  }

  return hints.slice(0, 4);
}
