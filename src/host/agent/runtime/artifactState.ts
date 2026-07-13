// ============================================================================
// ArtifactState — RuntimeContext artifact 域切片（ADR-038 批3e）
// ============================================================================
// 原 RuntimeContext 顶层散字段收敛于此：字段私有、读走 getter、写走显式方法。
// 纯搬家零行为变化——repair 状态机逻辑仍在调用方，本类只承载槽位与嵌套写。

/** 校验失败重建路径的 phase 阶梯（原定义在 toolArtifactRepairPolicy，随 failureState 一起收进切片层，原处 re-export 兼容） */
export type ArtifactRepairPhase = 'baseline_repair' | 'targeted_repair' | 'read_then_patch' | 'playability_repair' | 'fresh_rewrite';

/** guard.phase 全取值 = 重建家族 + 文本冷启动 seed 的 'initial_repair'。行为分支只认 'playability_repair'，其余仅展示/遥测。 */
export type ArtifactRepairGuardPhase = ArtifactRepairPhase | 'initial_repair';

/** 每目标校验失败状态（patience/重写/降级信号）。guard.attempts 的真源，goal 2× 兜底也读它。 */
export type ArtifactValidationFailureState = {
  attempts: number;
  phase: ArtifactRepairPhase;
  /** 历史最少失败项数（patience 基准，越小越好） */
  bestFailureCount?: number;
  /** 连续未刷新最佳成绩的轮数（patience 计数器） */
  roundsSinceBest?: number;
  /** 各失败码连续存活轮数（补丁抗性动态信号） */
  failureCodeStreaks?: Record<string, number>;
  /** 干净上下文重写是否已用掉（每目标一次机会） */
  rewriteAttempted?: boolean;
  /** goal 模式降级放行待办：由策略裁决置位，conversationRuntime 闸3 消费 */
  degradedReleasePending?: string;
};

export interface ArtifactRepairGuard {
  targetFile: string;
  attempts: number;
  phase: ArtifactRepairGuardPhase;
  // 统一无进展计数器（原 repairTurnsWithoutProgress + blockedToolTurnsWithoutProgress 合并）：
  // 修复期内所有"没推进目标文件"的动作都累加——unavailable-tool 回合、repair 闸 block。
  // 唯一清零点 = 目标文件被成功改动（markTargetPatched）；不再有每回合无条件清零（审计
  // HIGH-1 根治），故 phantom 目标死锁能跨回合累积到 ARTIFACT_REPAIR_MAX_ATTEMPTS 硬停。
  noProgressTurns?: number;
  lastBlockedTool?: string;
  patched?: boolean;
  lastFailedPatchFingerprint?: string;
  activeIssueCodes?: string[];
}

/**
 * Final artifact contract（maka 借鉴）：模型开工前声明的最终产物与草稿区。
 * 声明后产物校验/修复锁定/goal 证据闸/工作区卫生检查都以此为锚。
 */
export interface DeclaredDeliverables {
  /** 最终交付产物路径（相对 workingDirectory 或绝对路径） */
  finalArtifacts: string[];
  /** 草稿/中间产物目录（卫生检查豁免区） */
  scratchDir?: string;
  declaredAtMs: number;
}

/**
 * ADR-038 批3e: artifact 域共享状态切片。
 * 原 RuntimeContext 顶层散字段收敛于此：字段私有、读走 getter、写走显式方法，
 * "谁在写"从 grep 考古变成方法调用链。
 */
export class ArtifactState {
  private _repairGuard?: ArtifactRepairGuard;
  /** Last interactive artifact path that passed runtime/browser validation in this run. */
  private _validationPassedTargetFile?: string;
  private _declaredDeliverables?: DeclaredDeliverables;
  /** 每目标校验失败状态（原 RuntimeContext expando `artifactValidationFailures`，批3e 漏网字段收编） */
  private readonly _validationFailures = new Map<string, ArtifactValidationFailureState>();

  get repairGuard(): ArtifactRepairGuard | undefined {
    return this._repairGuard;
  }

  get validationFailures(): Map<string, ArtifactValidationFailureState> {
    return this._validationFailures;
  }

  get validationPassedTargetFile(): string | undefined {
    return this._validationPassedTargetFile;
  }

  get declaredDeliverables(): DeclaredDeliverables | undefined {
    return this._declaredDeliverables;
  }

  // --- repair guard 生命周期（W-slot）---

  /** 整体赋值（文本冷启动 seed 等无继承场景）；校验失败重建走 rebuildRepairGuardOnValidationFailure */
  setRepairGuard(guard: ArtifactRepairGuard): void {
    this._repairGuard = guard;
  }

  /**
   * 校验失败后重建 guard：同目标时无进展计数器/lastBlockedTool/失败指纹就地继承，
   * issueCodes 与旧 guard 合并去重（收编原 toolArtifactValidationLifecycle 的手抄逐字段继承——
   * 新增计数器字段只需改这里，不再依赖调用方记得抄）。patched 每次失败强制复位。
   */
  rebuildRepairGuardOnValidationFailure(next: {
    targetFile: string;
    attempts: number;
    phase: ArtifactRepairGuardPhase;
    lastFailedPatchFingerprint?: string;
    freshIssueCodes: string[];
  }): void {
    const previous = this._repairGuard?.targetFile === next.targetFile ? this._repairGuard : undefined;
    this._repairGuard = {
      targetFile: next.targetFile,
      attempts: next.attempts,
      phase: next.phase,
      patched: false,
      noProgressTurns: previous?.noProgressTurns,
      lastBlockedTool: previous?.lastBlockedTool,
      lastFailedPatchFingerprint: next.lastFailedPatchFingerprint ?? previous?.lastFailedPatchFingerprint,
      activeIssueCodes: [...new Set([...next.freshIssueCodes, ...(previous?.activeIssueCodes || [])])],
    };
  }

  clearRepairGuard(): void {
    this._repairGuard = undefined;
  }

  // --- repair guard 嵌套写（W-mut，方法内部 if (!this._repairGuard) return; 兜底）---

  /** 记一次无进展动作：计数 +1 并记录被拦工具名，返回累计值（无 guard 时不计，返回 0） */
  recordNoProgressTurn(blockedTool: string): number {
    if (!this._repairGuard) return 0;
    const turns = (this._repairGuard.noProgressTurns ?? 0) + 1;
    this._repairGuard.noProgressTurns = turns;
    this._repairGuard.lastBlockedTool = blockedTool;
    return turns;
  }

  /** 目标文件被成功改动 = 唯一的"有进展"信号，无进展计数就地清零 */
  markTargetPatched(): void {
    if (!this._repairGuard) return;
    this._repairGuard.patched = true;
    this._repairGuard.noProgressTurns = 0;
  }

  // --- validation passed（B 字段，含与 guard 的成对点）---

  /** 置 validationPassedTargetFile + 清 repairGuard（一步完成成对写） */
  markValidationPassed(targetFile: string): void {
    this._validationPassedTargetFile = targetFile;
    this._repairGuard = undefined;
  }

  setValidationPassed(targetFile: string): void {
    this._validationPassedTargetFile = targetFile;
  }

  clearValidationPassed(): void {
    this._validationPassedTargetFile = undefined;
  }

  // --- declared deliverables（C 字段）---

  /** 写入新声明，返回旧值供 trace */
  declareDeliverables(next: DeclaredDeliverables): DeclaredDeliverables | undefined {
    const previous = this._declaredDeliverables;
    this._declaredDeliverables = next;
    return previous;
  }

  /** @internal 测试专用：按种子构造任意初始状态，生产代码禁止调用 */
  static forTest(seed?: {
    repairGuard?: ArtifactRepairGuard;
    validationPassedTargetFile?: string;
    declaredDeliverables?: DeclaredDeliverables;
  }): ArtifactState {
    const state = new ArtifactState();
    if (!seed) return state;
    if (seed.repairGuard !== undefined) state._repairGuard = seed.repairGuard;
    if (seed.validationPassedTargetFile !== undefined) {
      state._validationPassedTargetFile = seed.validationPassedTargetFile;
    }
    if (seed.declaredDeliverables !== undefined) {
      state._declaredDeliverables = seed.declaredDeliverables;
    }
    return state;
  }
}
