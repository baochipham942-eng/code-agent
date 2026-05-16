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

export class AgentTask extends TaskKernel<AgentTaskStatus> {
  readonly agentType: string;
  readonly sidecarMetadata: SidecarMetadata;
  /** 预留字段：后续派生 MasterTask 时挂接到上层任务的引用，旧 metadata 缺失时为 undefined */
  parentMasterTaskId?: string;

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
      parentMasterTaskId: this.parentMasterTaskId,
    };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  static async loadFromDisk(sessionDir: string, agentId: string): Promise<AgentTask | null> {
    const agentDir = join(sessionDir, 'agents', agentId);
    const metadataPath = join(agentDir, 'metadata.json');
    const transcriptPath = join(agentDir, 'transcript.jsonl');

    if (!existsSync(metadataPath)) return null;

    const metaRaw = await readFile(metadataPath, 'utf-8');
    const meta = JSON.parse(metaRaw);

    const task = new AgentTask(meta.id, meta.sidecarMetadata);
    // Restore internal state directly (bypass state machine for loading)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): _status 是 TaskKernel 的 protected 字段，反序列化时需要绕过；应该提供 AgentTask.fromPersisted(meta) 静态构造器代替私有字段直写
    (task as any)._status = meta.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): 同上 _error 私有字段直写，应通过 fromPersisted 构造器
    (task as any)._error = meta.error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): 同上 _pendingMessages 私有字段直写，应通过 fromPersisted 构造器
    (task as any)._pendingMessages = meta.pendingMessages || [];

    // Restore dependency sets
    if (Array.isArray(meta.blocks)) {
      for (const id of meta.blocks) task.blocks.add(id);
    }
    if (Array.isArray(meta.blockedBy)) {
      for (const id of meta.blockedBy) task.blockedBy.add(id);
    }

    // Restore parent MasterTask reference (旧 metadata 无此字段时保持 undefined)
    if (typeof meta.parentMasterTaskId === 'string') {
      task.parentMasterTaskId = meta.parentMasterTaskId;
    }

    // Load transcript
    if (existsSync(transcriptPath)) {
      const transcriptRaw = await readFile(transcriptPath, 'utf-8');
      const lines = transcriptRaw.split('\n').filter(l => l.trim());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): _transcript 私有字段直写，应通过 fromPersisted 构造器
      (task as any)._transcript = lines.map((l: string) => JSON.parse(l));
    }

    return task;
  }
}
