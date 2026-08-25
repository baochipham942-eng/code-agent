import { SUBAGENT_COMPLETION_NOTIFICATIONS } from '../../shared/constants';
import { buildSpillNotice, spillToolResultArchive, type ToolResultArchiveRef } from '../utils/toolResultSpill';
import type { AgentFailureCode } from '../../shared/contract/agentFailure';

export type SubagentCompletionStatus = 'completed' | 'failed' | 'cancelled' | 'killed';
export type SubagentCompletionKind = 'user_visible' | 'internal' | 'shell';

export interface SubagentCompletionScope {
  sessionId?: string;
  runId?: string;
  treeId?: string;
}

export interface SubagentCompletionRecord extends SubagentCompletionScope {
  agentId: string;
  title: string;
  role?: string;
  kind: SubagentCompletionKind;
  status: SubagentCompletionStatus;
  summary: string;
  durationMs?: number;
  failureCode?: AgentFailureCode;
  archiveRef?: ToolResultArchiveRef;
  content: string;
  createdAt: number;
  dedupeKey: string;
}

export interface BuildSubagentCompletionRecordInput extends SubagentCompletionScope {
  agentId: string;
  title?: string;
  role?: string;
  kind?: SubagentCompletionKind;
  status: SubagentCompletionStatus;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  failureCode?: AgentFailureCode;
  toolsUsed?: string[];
  iterations?: number;
  cost?: number;
}

function statusLabel(status: SubagentCompletionStatus): string {
  return status === 'completed' ? 'completed' : `ended with ${status}`;
}

function scopeDedupePrefix(input: SubagentCompletionScope): string {
  return `${input.sessionId ?? 'global'}:${input.runId ?? 'session'}:${input.treeId ?? 'default'}`;
}

function buildCompletionAckInstruction(kind: SubagentCompletionKind, title: string): string {
  const namingRule = `提到子代理时，只能使用通知中的标题「${title}」，禁止使用 [agent]、[worker]、agent 或 worker 等泛称。`;
  if (kind === 'user_visible') {
    return `回应要求：结果已经展示给用户，不要复述子代理的原始结果；只用一句话归纳本批通知里的全部完成项。${namingRule}`;
  }
  if (kind === 'shell') {
    return `回应要求：用简短、非技术化的话向用户说明「${title}」的执行结果和下一步，不要只罗列退出码、日志或命令细节。${namingRule}`;
  }
  return `回应要求：结果只在内部上下文中。先完成必要的后续动作；没有后续动作时，不要回复用户。${namingRule}`;
}

function buildOutputSummary(input: BuildSubagentCompletionRecordInput): {
  summary: string;
  archiveRef?: ToolResultArchiveRef;
} {
  const raw = input.output || input.error || '';
  if (!raw) {
    return { summary: input.status === 'completed' ? 'No output was returned.' : 'No error output was returned.' };
  }

  if (raw.length <= SUBAGENT_COMPLETION_NOTIFICATIONS.INLINE_OUTPUT_LIMIT) {
    return { summary: raw };
  }

  const archive = spillToolResultArchive({
    content: raw,
    toolName: 'subagent_completion',
    sessionId: input.sessionId,
    toolCallId: input.agentId,
    reason: 'subagent-completion-notification',
  });
  if (!archive) {
    return {
      summary: `Output exceeded inline reminder budget. Use collect_agent("${input.agentId}") to fetch the final result.`,
    };
  }

  return {
    archiveRef: archive.archiveRef,
    summary:
      `Output exceeded inline reminder budget and was archived as ${archive.archiveRef.artifactId}. ` +
      `Use collect_agent("${input.agentId}") for the final result or read_tool_result_archive with that artifact_id for paged output.` +
      buildSpillNotice(archive.archiveRef),
  };
}

export function buildSubagentCompletionRecord(input: BuildSubagentCompletionRecordInput): SubagentCompletionRecord {
  const { summary, archiveRef } = buildOutputSummary(input);
  const title = input.title?.trim() || input.role?.trim() || input.agentId;
  const kind = input.kind ?? 'internal';
  const durationMs = typeof input.startedAt === 'number' && typeof input.finishedAt === 'number'
    ? Math.max(0, input.finishedAt - input.startedAt)
    : undefined;
  const payload = {
    agent_id: input.agentId,
    title,
    role: input.role,
    completion_kind: kind,
    status: input.status,
    summary,
    stats: {
      tool_calls: input.toolsUsed?.length ?? 0,
      iterations: input.iterations ?? 0,
      cost: input.cost,
      duration_ms: durationMs,
    },
    failure_code: input.failureCode,
    archive: archiveRef
      ? {
          artifact_id: archiveRef.artifactId,
          bytes: archiveRef.bytes,
          sha256: archiveRef.sha256.slice(0, 12),
        }
      : undefined,
    next_action: `Use collect_agent("${input.agentId}") to inspect the final result.`,
  };
  const ackInstruction = buildCompletionAckInstruction(kind, title);
  const content = `<subagent_notification>\n${JSON.stringify(payload, null, 2)}\n<completion_ack_instruction>\n${ackInstruction}\n</completion_ack_instruction>\n</subagent_notification>`;
  return {
    agentId: input.agentId,
    title,
    role: input.role,
    kind,
    status: input.status,
    summary,
    durationMs,
    failureCode: input.failureCode,
    archiveRef,
    sessionId: input.sessionId,
    runId: input.runId,
    treeId: input.treeId,
    content,
    createdAt: Date.now(),
    dedupeKey: `${scopeDedupePrefix(input)}:${input.agentId}:${input.status}:${input.finishedAt ?? 'unknown'}`,
  };
}

export function formatSystemReminderForCompletions(records: readonly SubagentCompletionRecord[]): string {
  if (records.length === 0) return '';
  const title = records.length === 1
    ? '1 background task completed'
    : `${records.length} background tasks completed`;
  const body = records
    .map((record) => {
      const role = record.role ? ` (${record.role})` : '';
      const duration = typeof record.durationMs === 'number' ? `, duration_ms=${record.durationMs}` : '';
      const title = record.title || record.role || record.agentId;
      return `- ${title}${role}: ${statusLabel(record.status)}${duration}\n${record.content}`;
    })
    .join('\n');
  return `<system-reminder>\n${title}\n${body}\n</system-reminder>`;
}
