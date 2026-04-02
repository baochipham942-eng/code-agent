import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

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

export interface TranscriptEntry {
  role: string;
  content: string;
  timestamp: number;
  toolCallId?: string;
}

/** Hook 回调类型：调用方可选注入，用于触发 TaskCreated/TaskCompleted 等事件 */
export type TaskHookCallback = (event: 'TaskCreated' | 'TaskCompleted', payload: {
  taskId: string;
  agentType: string;
  success?: boolean;
}) => void;

export class AgentTask {
  readonly id: string;
  private _status: AgentTaskStatus = 'pending';
  readonly agentType: string;
  abortController: AbortController | null = null;
  private _pendingMessages: Array<{ role: string; content: string }> = [];
  private _transcript: TranscriptEntry[] = [];
  readonly sidecarMetadata: SidecarMetadata;
  private _error?: string;

  // --- 任务依赖 ---
  readonly blocks: Set<string> = new Set();
  readonly blockedBy: Set<string> = new Set();

  // --- Hook 回调（可选，由调用方注入） ---
  onHook?: TaskHookCallback;

  get status(): AgentTaskStatus { return this._status; }

  constructor(id: string, metadata: SidecarMetadata) {
    this.id = id;
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

  get error(): string | undefined { return this._error; }

  // --- 依赖管理 ---

  addDependency(blockerId: string): void {
    this.blockedBy.add(blockerId);
  }

  removeDependency(blockerId: string): void {
    this.blockedBy.delete(blockerId);
  }

  isReady(): boolean {
    return this.blockedBy.size === 0;
  }

  private assertTransition(target: AgentTaskStatus, validFrom: AgentTaskStatus[]): void {
    if (!validFrom.includes(this._status)) {
      throw new InvalidStateTransitionError(this._status, target);
    }
  }

  // --- Transcript ---

  appendTranscript(entry: TranscriptEntry): void {
    this._transcript.push(entry);
  }

  getTranscript(): readonly TranscriptEntry[] {
    return [...this._transcript];
  }

  // --- Pending messages ---

  enqueuePendingMessage(message: { role: string; content: string }): void {
    this._pendingMessages.push(message);
  }

  drainPendingMessages(): Array<{ role: string; content: string }> {
    const messages = [...this._pendingMessages];
    this._pendingMessages = [];
    return messages;
  }

  getPendingMessageCount(): number {
    return this._pendingMessages.length;
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
      pendingMessages: this._pendingMessages,
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
    const meta = JSON.parse(metaRaw);

    const task = new AgentTask(meta.id, meta.sidecarMetadata);
    // Restore internal state directly (bypass state machine for loading)
    (task as any)._status = meta.status;
    (task as any)._error = meta.error;
    (task as any)._pendingMessages = meta.pendingMessages || [];

    // Restore dependency sets
    if (Array.isArray(meta.blocks)) {
      for (const id of meta.blocks) task.blocks.add(id);
    }
    if (Array.isArray(meta.blockedBy)) {
      for (const id of meta.blockedBy) task.blockedBy.add(id);
    }

    // Load transcript
    if (existsSync(transcriptPath)) {
      const transcriptRaw = await readFile(transcriptPath, 'utf-8');
      const lines = transcriptRaw.split('\n').filter(l => l.trim());
      (task as any)._transcript = lines.map((l: string) => JSON.parse(l));
    }

    return task;
  }
}
