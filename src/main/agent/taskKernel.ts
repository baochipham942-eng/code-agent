// ============================================================================
// TaskKernel — 任务运行时抽象基类
// ============================================================================
//
// 提供与具体状态机字面量无关的通用运行时能力（transcript、pending messages、
// 依赖追踪、状态访问与 transition 断言、hook 回调注入）。
//
// 具体任务类型（AgentTask、未来的 MasterTask）通过指定泛型状态参数 `S` 派生，
// 并各自维护：
//   - 状态机方法（register/start/stop 等，名字与允许的 transition 可不同）
//   - 业务特有字段（agentType / sidecarMetadata / parentMasterTaskId 等）
//   - 持久化逻辑（saveToDisk / loadFromDisk，schema 可能不同）
//
// 注意：TaskHookCallback 当前固定 'TaskCreated' | 'TaskCompleted' 字面量，
// 后续若 MasterTask 需要新增事件，再讨论是否泛化（本次保持原状）。
// ============================================================================

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

export abstract class TaskKernel<S extends string> {
  readonly id: string;
  protected _status: S;
  protected _transcript: TranscriptEntry[] = [];
  abortController: AbortController | null = null;
  private _pendingMessages: Array<{ role: string; content: string }> = [];
  protected _error?: string;

  // --- 任务依赖 ---
  readonly blocks: Set<string> = new Set();
  readonly blockedBy: Set<string> = new Set();

  // --- Hook 回调（可选，由调用方注入） ---
  onHook?: TaskHookCallback;

  constructor(id: string, initialStatus: S) {
    this.id = id;
    this._status = initialStatus;
  }

  get status(): S { return this._status; }
  get error(): string | undefined { return this._error; }

  // --- State transition 工具（派生类的状态机方法调用） ---

  protected assertTransition(target: S, validFrom: S[]): void {
    if (!validFrom.includes(this._status)) {
      // 派生类负责构造合适的错误（携带具体 Status 字面量），这里只提供通用兜底。
      throw new Error(`Invalid state transition: ${this._status} → ${target}`);
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

  /**
   * 供派生类持久化时读取 pending 队列快照（保持 _pendingMessages 私有的前提下
   * 提供受控读取入口）。返回内部数组的引用——仅用于序列化场景，调用方不得修改。
   */
  protected getPendingMessagesSnapshot(): Array<{ role: string; content: string }> {
    return this._pendingMessages;
  }

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
}
