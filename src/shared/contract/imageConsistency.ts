// 一致性锁定再编辑（T4）契约类型：main 侧局部重绘后的"未选区域一致性"报告。
// main(handleEditDesignImage) 产出、renderer(editRegion/UI 徽章) 消费，故放 shared。

/** 最终产物处置：clean=模型自身守住未选区，直接采用；locked=未选区越界，已把原图未选区逐像素贴回。 */
export type RegionLockStatus = 'clean' | 'locked';

/** 局部重绘一致性报告（diff-gate 度量 + region-lock 处置）。 */
export interface RegionLockReport {
  /** 未选区域是否在感知 ε 内未变（= 模型自身是否守住了 scope）。 */
  passed: boolean;
  /** 最终产物处置（clean / locked）。 */
  status: RegionLockStatus;
  /** 未选区域单像素最大通道差（0-255）。 */
  maxDelta: number;
  /** 未选区域平均通道差（0-255）。 */
  meanDelta: number;
  /** 未选区域内超过 ε 的像素数。 */
  changedPixels: number;
  /** 未选区域（留区）总像素数。 */
  keepPixels: number;
  /** 感知容差阈值（0-255）。 */
  epsilon: number;
  /** 模型返回尺寸是否与原图一致（不一致已 resize 对齐再做 gate/合成）。 */
  dimensionMatched: boolean;
  /** diff 证据图相对 run 目录的路径（仅 status==='locked' 生成）。 */
  diffPath?: string;
}
