import type { Message } from '../../../shared/contract';

/**
 * ADR-038 批3b: run 级控制流状态切片（取消/中断/abort/plan 快照/强制收尾）。
 * 字段私有、读走 getter、写走显式方法。
 * 生命周期与原字段一致：per AgentLoop 实例，无每轮重置（cancel/interrupt 置位后
 * 靠 AgentLoop 重建回位，本切片不改变该语义）。
 */
export class ControlState {
  private _isCancelled = false;
  private _isInterrupted = false;
  /** per-inference controller：inference 层建/清，conversationRuntime 只触发 abort */
  private _abortController: AbortController | null = null;
  /** per-run controller：conversationRuntime 建/清，下游只读 .signal 透传 */
  private _runAbortController: AbortController | null = null;
  private _savedMessages: Message[] | null = null;
  private _forceFinalResponseReason?: string;
  private _forceFinalResponsePrompt?: string;
  private readonly _preApprovedTools = new Set<string>();
  private _externalDataCallCount = 0;

  get isCancelled(): boolean { return this._isCancelled; }
  get isInterrupted(): boolean { return this._isInterrupted; }
  get abortController(): AbortController | null { return this._abortController; }
  get runAbortController(): AbortController | null { return this._runAbortController; }
  get savedMessages(): Message[] | null { return this._savedMessages; }
  get forceFinalResponseReason(): string | undefined { return this._forceFinalResponseReason; }
  get forceFinalResponsePrompt(): string | undefined { return this._forceFinalResponsePrompt; }
  get preApprovedTools(): Set<string> { return this._preApprovedTools; }
  get externalDataCallCount(): number { return this._externalDataCallCount; }

  markCancelled(): void {
    this._isCancelled = true;
  }

  markInterrupted(): void {
    this._isInterrupted = true;
  }

  /** 触发当前推理中断（controller 槽位不动，由 inference 层自清） */
  abortInference(): void {
    this._abortController?.abort();
  }

  abortRun(): void {
    this._runAbortController?.abort();
  }

  setInferenceAbortController(controller: AbortController | null): void {
    this._abortController = controller;
  }

  setRunAbortController(controller: AbortController | null): void {
    this._runAbortController = controller;
  }

  /** plan mode 进入：快照当前会话消息（拷贝） */
  savePlanSnapshot(messages: Message[]): void {
    this._savedMessages = [...messages];
  }

  clearSavedMessages(): void {
    this._savedMessages = null;
  }

  /** 强制收尾：Reason/Prompt 恒成对写入（原字段的全部写点均为成对） */
  forceFinalResponse(reason: string, prompt?: string): void {
    this._forceFinalResponseReason = reason;
    this._forceFinalResponsePrompt = prompt;
  }

  clearForceFinalResponse(): void {
    this._forceFinalResponseReason = undefined;
    this._forceFinalResponsePrompt = undefined;
  }

  preApproveTool(toolName: string): void {
    this._preApprovedTools.add(toolName);
  }

  resetExternalDataCalls(): void {
    this._externalDataCallCount = 0;
  }

  /** 自增并返回新值 */
  incrementExternalDataCalls(): number {
    return ++this._externalDataCallCount;
  }

  /** @internal 测试专用：按种子构造任意初始状态，生产代码禁止调用 */
  static forTest(seed?: {
    isCancelled?: boolean;
    isInterrupted?: boolean;
    abortController?: AbortController | null;
    runAbortController?: AbortController | null;
    savedMessages?: Message[] | null;
    forceFinalResponseReason?: string;
    forceFinalResponsePrompt?: string;
    preApprovedTools?: Iterable<string>;
    externalDataCallCount?: number;
  }): ControlState {
    const state = new ControlState();
    if (!seed) return state;
    if (seed.isCancelled !== undefined) state._isCancelled = seed.isCancelled;
    if (seed.isInterrupted !== undefined) state._isInterrupted = seed.isInterrupted;
    if (seed.abortController !== undefined) state._abortController = seed.abortController;
    if (seed.runAbortController !== undefined) state._runAbortController = seed.runAbortController;
    if (seed.savedMessages !== undefined) state._savedMessages = seed.savedMessages;
    if (seed.forceFinalResponseReason !== undefined) state._forceFinalResponseReason = seed.forceFinalResponseReason;
    if (seed.forceFinalResponsePrompt !== undefined) state._forceFinalResponsePrompt = seed.forceFinalResponsePrompt;
    if (seed.preApprovedTools !== undefined) for (const t of seed.preApprovedTools) state._preApprovedTools.add(t);
    if (seed.externalDataCallCount !== undefined) state._externalDataCallCount = seed.externalDataCallCount;
    return state;
  }
}
