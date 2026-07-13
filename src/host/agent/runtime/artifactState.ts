// ============================================================================
// ArtifactState — RuntimeContext artifact 域切片（ADR-038 批3e）
// ============================================================================
// 原 RuntimeContext 顶层散字段收敛于此：字段私有、读走 getter、写走显式方法。
// 纯搬家零行为变化——repair 状态机逻辑仍在调用方，本类只承载槽位与嵌套写。

export interface ArtifactRepairGuard {
  targetFile: string;
  attempts: number;
  phase: string;
  // Route A loop guard: repair turns since the last successful target-file
  // mutation. Reaching ARTIFACT_REPAIR_MAX_ATTEMPTS force-stops the repair turn.
  repairTurnsWithoutProgress?: number;
  // Route A block-path loop guard：可用但被 repair 闸 block 的工具连续无进展次数。
  // 独立于 repairTurnsWithoutProgress（后者每回合被 messageProcessor 无条件清零，
  // 无法兜住"目标不可达→每个工具都被 block"的死锁）。仅 block 路径累加、目标文件被
  // 成功改动(patched)时清零，到 ARTIFACT_REPAIR_MAX_ATTEMPTS 硬停。
  blockedToolTurnsWithoutProgress?: number;
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

  get repairGuard(): ArtifactRepairGuard | undefined {
    return this._repairGuard;
  }

  get validationPassedTargetFile(): string | undefined {
    return this._validationPassedTargetFile;
  }

  get declaredDeliverables(): DeclaredDeliverables | undefined {
    return this._declaredDeliverables;
  }

  // --- repair guard 生命周期（W-slot）---

  /** 整体赋值；对象由调用方拼（继承/合并逻辑留在原地） */
  setRepairGuard(guard: ArtifactRepairGuard): void {
    this._repairGuard = guard;
  }

  clearRepairGuard(): void {
    this._repairGuard = undefined;
  }

  // --- repair guard 嵌套写（W-mut，方法内部 if (!this._repairGuard) return; 兜底）---

  registerBlockedToolTurn(turns: number, blockedTool: string): void {
    if (!this._repairGuard) return;
    this._repairGuard.blockedToolTurnsWithoutProgress = turns;
    this._repairGuard.lastBlockedTool = blockedTool;
  }

  resetRepairTurnsWithoutProgress(): void {
    if (!this._repairGuard) return;
    this._repairGuard.repairTurnsWithoutProgress = 0;
  }

  markTargetPatched(): void {
    if (!this._repairGuard) return;
    this._repairGuard.patched = true;
    this._repairGuard.blockedToolTurnsWithoutProgress = 0;
  }

  recordUnavailableToolTurn(repairTurnsWithoutProgress: number, lastBlockedTool: string): void {
    if (!this._repairGuard) return;
    this._repairGuard.repairTurnsWithoutProgress = repairTurnsWithoutProgress;
    this._repairGuard.lastBlockedTool = lastBlockedTool;
  }

  recordBlockedTool(toolName: string): void {
    if (!this._repairGuard) return;
    this._repairGuard.lastBlockedTool = toolName;
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
