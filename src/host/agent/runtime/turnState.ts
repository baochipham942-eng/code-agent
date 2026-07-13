import type { EffortLevel } from '../../../shared/contract/agent';
import type { SkillToolBoundary } from '../../../shared/contract/agentSkill';
import type { SkillInvocationMatchKind } from '../../services/skills/skillInvocationResolver';

export interface ActiveSkillInvocation {
  skillName: string;
  source: string;
  basePath: string;
  matchKind: SkillInvocationMatchKind;
  matchedText: string;
  aliases: string[];
  confidence: number;
}

/**
 * ADR-038 批3a: turn 级共享状态切片。
 * 原 RuntimeContext 顶层散字段收敛于此：字段私有、读走 getter、写走显式方法，
 * "谁在写"从 grep 考古变成方法调用链。
 */
export class TurnState {
  // --- turn/iteration 生命周期 ---
  private _currentTurnId = '';
  private _messageDeltaSeq = 0;
  private _currentIterationSpanId = '';
  private _turnStartTime = 0;
  private _toolsUsedInTurn: string[] = [];

  // --- 推理流转 ---
  private _lastStreamedContent = '';
  private _needsReinference = false;
  private _isSimpleTaskMode = false;

  // --- thinking/effort ---
  private _effortLevel: EffortLevel = 'high';
  private _thinkingEnabled = true;
  private _thinkingStepCount = 0;

  // --- research mode ---
  private _researchModeActive = false;
  private _researchIterationCount = 0;

  // --- 激活 skill ---
  private _activeSkillInvocation?: ActiveSkillInvocation;
  private _activeSkillContextBlock?: string;
  private _skillToolBoundary?: SkillToolBoundary;

  get currentTurnId(): string { return this._currentTurnId; }
  get messageDeltaSeq(): number { return this._messageDeltaSeq; }
  get currentIterationSpanId(): string { return this._currentIterationSpanId; }
  get turnStartTime(): number { return this._turnStartTime; }
  get toolsUsedInTurn(): string[] { return this._toolsUsedInTurn; }
  get lastStreamedContent(): string { return this._lastStreamedContent; }
  get needsReinference(): boolean { return this._needsReinference; }
  get isSimpleTaskMode(): boolean { return this._isSimpleTaskMode; }
  get effortLevel(): EffortLevel { return this._effortLevel; }
  get thinkingEnabled(): boolean { return this._thinkingEnabled; }
  get thinkingStepCount(): number { return this._thinkingStepCount; }
  get researchModeActive(): boolean { return this._researchModeActive; }
  get researchIterationCount(): number { return this._researchIterationCount; }
  get activeSkillInvocation(): ActiveSkillInvocation | undefined { return this._activeSkillInvocation; }
  get activeSkillContextBlock(): string | undefined { return this._activeSkillContextBlock; }
  get skillToolBoundary(): SkillToolBoundary | undefined { return this._skillToolBoundary; }

  /** run 开始：清 turn 标识（原 conversationRuntime#run 起始段语义） */
  beginRun(): void {
    this._currentTurnId = '';
  }

  /** iteration 开始：新 turn id + delta 序号归零 + iteration span（原 streamHandler#setupIteration 前段） */
  beginTurn(turnId: string, iterationSpanId: string): void {
    this._currentTurnId = turnId;
    this._messageDeltaSeq = 0;
    this._currentIterationSpanId = iterationSpanId;
  }

  /** iteration 计时与本 turn 工具清单归零（原 streamHandler#setupIteration 后段） */
  markTurnStart(): void {
    this._turnStartTime = Date.now();
    this._toolsUsedInTurn = [];
  }

  /** 前置自增并返回（原 `++ctx.turn.messageDeltaSeq`） */
  nextMessageDeltaSeq(): number {
    return ++this._messageDeltaSeq;
  }

  recordToolUse(toolName: string): void {
    this._toolsUsedInTurn.push(toolName);
  }

  resetStreamedContent(): void {
    this._lastStreamedContent = '';
  }

  appendStreamedContent(chunk: string): void {
    this._lastStreamedContent += chunk;
  }

  requestReinference(): void {
    this._needsReinference = true;
  }

  clearReinference(): void {
    this._needsReinference = false;
  }

  setSimpleTaskMode(value: boolean): void {
    this._isSimpleTaskMode = value;
  }

  setEffortLevel(level: EffortLevel): void {
    this._effortLevel = level;
  }

  setThinkingEnabled(enabled: boolean): void {
    this._thinkingEnabled = enabled;
  }

  resetThinkingSteps(): void {
    this._thinkingStepCount = 0;
  }

  incrementThinkingStep(): void {
    this._thinkingStepCount++;
  }

  /** 进入 research 模式并清零轮次计数（原 modeInjection 注入点语义） */
  enterResearchMode(): void {
    this._researchModeActive = true;
    this._researchIterationCount = 0;
  }

  incrementResearchIteration(): number {
    return ++this._researchIterationCount;
  }

  activateSkill(invocation: ActiveSkillInvocation, contextBlock?: string): void {
    this._activeSkillInvocation = invocation;
    this._activeSkillContextBlock = contextBlock;
  }

  clearActiveSkill(): void {
    this._activeSkillInvocation = undefined;
    this._activeSkillContextBlock = undefined;
  }

  setSkillToolBoundary(boundary: SkillToolBoundary | undefined): void {
    this._skillToolBoundary = boundary;
  }

  /** @internal 测试专用：按种子构造任意初始状态，生产代码禁止调用 */
  static forTest(seed?: {
    currentTurnId?: string;
    messageDeltaSeq?: number;
    currentIterationSpanId?: string;
    turnStartTime?: number;
    toolsUsedInTurn?: string[];
    lastStreamedContent?: string;
    needsReinference?: boolean;
    isSimpleTaskMode?: boolean;
    effortLevel?: EffortLevel;
    thinkingEnabled?: boolean;
    thinkingStepCount?: number;
    researchModeActive?: boolean;
    researchIterationCount?: number;
    activeSkillInvocation?: ActiveSkillInvocation;
    activeSkillContextBlock?: string;
    skillToolBoundary?: SkillToolBoundary;
  }): TurnState {
    const state = new TurnState();
    if (!seed) return state;
    if (seed.currentTurnId !== undefined) state._currentTurnId = seed.currentTurnId;
    if (seed.messageDeltaSeq !== undefined) state._messageDeltaSeq = seed.messageDeltaSeq;
    if (seed.currentIterationSpanId !== undefined) state._currentIterationSpanId = seed.currentIterationSpanId;
    if (seed.turnStartTime !== undefined) state._turnStartTime = seed.turnStartTime;
    if (seed.toolsUsedInTurn !== undefined) state._toolsUsedInTurn = seed.toolsUsedInTurn;
    if (seed.lastStreamedContent !== undefined) state._lastStreamedContent = seed.lastStreamedContent;
    if (seed.needsReinference !== undefined) state._needsReinference = seed.needsReinference;
    if (seed.isSimpleTaskMode !== undefined) state._isSimpleTaskMode = seed.isSimpleTaskMode;
    if (seed.effortLevel !== undefined) state._effortLevel = seed.effortLevel;
    if (seed.thinkingEnabled !== undefined) state._thinkingEnabled = seed.thinkingEnabled;
    if (seed.thinkingStepCount !== undefined) state._thinkingStepCount = seed.thinkingStepCount;
    if (seed.researchModeActive !== undefined) state._researchModeActive = seed.researchModeActive;
    if (seed.researchIterationCount !== undefined) state._researchIterationCount = seed.researchIterationCount;
    if (seed.activeSkillInvocation !== undefined) state._activeSkillInvocation = seed.activeSkillInvocation;
    if (seed.activeSkillContextBlock !== undefined) state._activeSkillContextBlock = seed.activeSkillContextBlock;
    if (seed.skillToolBoundary !== undefined) state._skillToolBoundary = seed.skillToolBoundary;
    return state;
  }
}
