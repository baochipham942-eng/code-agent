import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

import { TaskKernel, type TranscriptEntry, type TaskHookCallback } from './taskKernel';

// 透传 kernel 公共类型，保持原 './agentTask' 模块对外 API 不变。
export type { TranscriptEntry, TaskHookCallback };

export type AgentTaskStatus = 'pending' | 'registered' | 'running' | 'stopped' | 'resumed' | 'failed' | 'cancelled';

export class InvalidStateTransitionError extends Error {
  constructor(from: AgentTaskStatus, to: AgentTaskStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export interface SidecarMetadata {
  agentType: string;
  worktreePath?: string;
  parentSessionId: string;
  spawnTime: number;
  model: string;
  toolPool: string[];
}

type PendingMessage = { role: string; content: string };

type PersistedAgentTaskMetadata = {
  id: string;
  status: AgentTaskStatus;
  sidecarMetadata: SidecarMetadata;
  error?: string;
  pendingMessages?: PendingMessage[];
  blocks?: string[];
  blockedBy?: string[];
};

const AGENT_TASK_STATUSES: readonly AgentTaskStatus[] = [
  'pending',
  'registered',
  'running',
  'stopped',
  'resumed',
  'failed',
  'cancelled',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonValue(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isAgentTaskStatus(value: unknown): value is AgentTaskStatus {
  return AGENT_TASK_STATUSES.includes(value as AgentTaskStatus);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizePendingMessages(value: unknown): PendingMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .flatMap((item) => {
      const role = item.role;
      const content = item.content;
      return typeof role === 'string' && typeof content === 'string'
        ? [{ role, content }]
        : [];
    });
}

function normalizeSidecarMetadata(value: unknown): SidecarMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.agentType !== 'string' ||
    typeof value.parentSessionId !== 'string' ||
    typeof value.spawnTime !== 'number' ||
    typeof value.model !== 'string'
  ) {
    return null;
  }

  return {
    agentType: value.agentType,
    worktreePath: typeof value.worktreePath === 'string' ? value.worktreePath : undefined,
    parentSessionId: value.parentSessionId,
    spawnTime: value.spawnTime,
    model: value.model,
    toolPool: normalizeStringArray(value.toolPool),
  };
}

function normalizePersistedMetadata(value: unknown): PersistedAgentTaskMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const sidecarMetadata = normalizeSidecarMetadata(value.sidecarMetadata);
  if (
    typeof value.id !== 'string' ||
    !isAgentTaskStatus(value.status) ||
    !sidecarMetadata
  ) {
    return null;
  }

  return {
    id: value.id,
    status: value.status,
    sidecarMetadata,
    error: typeof value.error === 'string' ? value.error : undefined,
    pendingMessages: normalizePendingMessages(value.pendingMessages),
    blocks: normalizeStringArray(value.blocks),
    blockedBy: normalizeStringArray(value.blockedBy),
  };
}

function normalizeTranscriptEntry(value: unknown): TranscriptEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.role !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.timestamp !== 'number'
  ) {
    return null;
  }

  return {
    role: value.role,
    content: value.content,
    timestamp: value.timestamp,
    toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
  };
}

export class AgentTask extends TaskKernel<AgentTaskStatus> {
  readonly agentType: string;
  readonly sidecarMetadata: SidecarMetadata;

  constructor(id: string, metadata: SidecarMetadata) {
    super(id, 'pending');
    this.agentType = metadata.agentType;
    this.sidecarMetadata = metadata;
  }

  // --- State transitions (throw InvalidStateTransitionError on invalid) ---

  register(): void {
    this.assertTransition('registered', ['pending']);
    this._status = 'registered';
    // 触发 TaskCreated hook
    this.onHook?.('TaskCreated', { taskId: this.id, agentType: this.agentType });
  }

  start(): void {
    this.assertTransition('running', ['registered', 'resumed']);
    this._status = 'running';
    this.abortController = new AbortController();
  }

  stop(): void {
    this.assertTransition('stopped', ['running']);
    this._status = 'stopped';
    this.abortController = null;
    // 触发 TaskCompleted hook（正常完成）
    this.onHook?.('TaskCompleted', { taskId: this.id, agentType: this.agentType, success: true });
  }

  resume(): void {
    this.assertTransition('resumed', ['stopped']);
    this._status = 'resumed';
  }

  fail(error: string): void {
    this.assertTransition('failed', ['running']);
    this._status = 'failed';
    this._error = error;
    this.abortController = null;
    // 触发 TaskCompleted hook（失败）
    this.onHook?.('TaskCompleted', { taskId: this.id, agentType: this.agentType, success: false });
  }

  cancel(): void {
    if (this._status === 'failed' || this._status === 'cancelled') {
      throw new InvalidStateTransitionError(this._status, 'cancelled');
    }
    this._status = 'cancelled';
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // 触发 TaskCompleted hook（取消）
    this.onHook?.('TaskCompleted', { taskId: this.id, agentType: this.agentType, success: false });
  }

  /** 覆盖基类默认实现，抛出携带具体 AgentTaskStatus 的专用错误 */
  protected assertTransition(target: AgentTaskStatus, validFrom: AgentTaskStatus[]): void {
    if (!validFrom.includes(this._status)) {
      throw new InvalidStateTransitionError(this._status, target);
    }
  }

  // --- Persistence ---

  async saveToDisk(sessionDir: string): Promise<void> {
    const agentDir = join(sessionDir, 'agents', this.id);
    if (!existsSync(agentDir)) {
      await mkdir(agentDir, { recursive: true });
    }

    // Transcript: JSONL format
    const transcriptPath = join(agentDir, 'transcript.jsonl');
    const transcriptContent = this._transcript.map(e => JSON.stringify(e)).join('\n');
    await writeFile(transcriptPath, transcriptContent, 'utf-8');

    // Metadata: JSON
    const metadataPath = join(agentDir, 'metadata.json');
    const metadata = {
      id: this.id,
      status: this._status,
      agentType: this.agentType,
      sidecarMetadata: this.sidecarMetadata,
      error: this._error,
      pendingMessages: this.getPendingMessagesSnapshot(),
      blocks: Array.from(this.blocks),
      blockedBy: Array.from(this.blockedBy),
    };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  static async loadFromDisk(sessionDir: string, agentId: string): Promise<AgentTask | null> {
    const agentDir = join(sessionDir, 'agents', agentId);
    const metadataPath = join(agentDir, 'metadata.json');
    const transcriptPath = join(agentDir, 'transcript.jsonl');

    if (!existsSync(metadataPath)) return null;

    const metaRaw = await readFile(metadataPath, 'utf-8');
    const meta = normalizePersistedMetadata(parseJsonValue(metaRaw));
    if (!meta) return null;

    const task = new AgentTask(meta.id, meta.sidecarMetadata);
    task.restorePersistedRuntimeState({
      status: meta.status,
      error: meta.error,
      pendingMessages: meta.pendingMessages,
    });

    // Restore dependency sets
    for (const id of meta.blocks ?? []) task.blocks.add(id);
    for (const id of meta.blockedBy ?? []) task.blockedBy.add(id);

    // Load transcript
    if (existsSync(transcriptPath)) {
      const transcriptRaw = await readFile(transcriptPath, 'utf-8');
      const lines = transcriptRaw.split('\n').filter(l => l.trim());
      const transcript = lines
        .map((line) => normalizeTranscriptEntry(parseJsonValue(line)))
        .filter((entry): entry is TranscriptEntry => entry !== null);
      task.restorePersistedRuntimeState({
        status: task.status,
        error: task.error,
        pendingMessages: task.getPendingMessagesSnapshot(),
        transcript,
      });
    }

    return task;
  }
}
