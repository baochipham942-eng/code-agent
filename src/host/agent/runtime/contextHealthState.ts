import type { CompressionState } from '../../context/compressionState';

/**
 * ADR-038 批3c: 上下文健康/压缩域切片。
 * 字段私有、读走 getter、写走显式方法。
 * 持久化面：compressionState 与 persistentSystemContext 经 runtimeStatePersistence
 * 落库（其余字段纯内存）；persistentSystemContext 是原地变异数组（systemContextStack
 * 对同一引用 push/splice），getter 返回活引用，禁止改成"返回新数组"语义。
 */
export class ContextHealthState {
  private _compressionState: CompressionState;
  private readonly _persistentSystemContext: string[];
  private _pipelineAutocompactNeeded = false;
  private _droppedPromptBlocks?: string[] = [];
  private _currentSystemPromptHash?: string;
  private _checkpointRebuildLastWatermarkId?: string;
  private _networkRetryCount?: number = 0;

  constructor(init: { compressionState: CompressionState; persistentSystemContext: string[] }) {
    this._compressionState = init.compressionState;
    this._persistentSystemContext = init.persistentSystemContext;
  }

  get compressionState(): CompressionState { return this._compressionState; }
  get persistentSystemContext(): string[] { return this._persistentSystemContext; }
  get pipelineAutocompactNeeded(): boolean { return this._pipelineAutocompactNeeded; }
  get droppedPromptBlocks(): string[] | undefined { return this._droppedPromptBlocks; }
  get currentSystemPromptHash(): string | undefined { return this._currentSystemPromptHash; }
  get checkpointRebuildLastWatermarkId(): string | undefined { return this._checkpointRebuildLastWatermarkId; }
  get networkRetryCount(): number | undefined { return this._networkRetryCount; }

  /** 压缩态整体替换（建/克隆新实例 → 变异 → 替换槽，pipeline 不碰活体） */
  replaceCompressionState(next: CompressionState): void {
    this._compressionState = next;
  }

  setPipelineAutocompactNeeded(value: boolean): void {
    this._pipelineAutocompactNeeded = value;
  }

  /** 每次 system prompt 构建前重置丢块清单 */
  resetDroppedPromptBlocks(): void {
    this._droppedPromptBlocks = [];
  }

  /** cache 命中路径：还原快照里的丢块清单 */
  restoreDroppedPromptBlocks(blocks: string[]): void {
    this._droppedPromptBlocks = blocks;
  }

  recordDroppedPromptBlock(label: string): void {
    (this._droppedPromptBlocks ??= []).push(label);
  }

  setSystemPromptHash(hash: string): void {
    this._currentSystemPromptHash = hash;
  }

  setCheckpointWatermark(watermarkId: string): void {
    this._checkpointRebuildLastWatermarkId = watermarkId;
  }

  setNetworkRetryCount(count: number): void {
    this._networkRetryCount = count;
  }

  /** @internal 测试专用：按种子构造任意初始状态，生产代码禁止调用 */
  static forTest(seed?: {
    compressionState?: CompressionState;
    persistentSystemContext?: string[];
    pipelineAutocompactNeeded?: boolean;
    droppedPromptBlocks?: string[];
    currentSystemPromptHash?: string;
    checkpointRebuildLastWatermarkId?: string;
    networkRetryCount?: number;
  }): ContextHealthState {
    const state = new ContextHealthState({
      compressionState: seed?.compressionState ?? ({} as CompressionState),
      persistentSystemContext: seed?.persistentSystemContext ?? [],
    });
    if (!seed) return state;
    if (seed.pipelineAutocompactNeeded !== undefined) state._pipelineAutocompactNeeded = seed.pipelineAutocompactNeeded;
    if (seed.droppedPromptBlocks !== undefined) state._droppedPromptBlocks = seed.droppedPromptBlocks;
    if (seed.currentSystemPromptHash !== undefined) state._currentSystemPromptHash = seed.currentSystemPromptHash;
    if (seed.checkpointRebuildLastWatermarkId !== undefined) state._checkpointRebuildLastWatermarkId = seed.checkpointRebuildLastWatermarkId;
    if (seed.networkRetryCount !== undefined) state._networkRetryCount = seed.networkRetryCount;
    return state;
  }
}
