/** 视觉分析 / 截图处理配置 */
export const VISION_IMAGE = {
  /** 发给视觉模型的最长边上限 (px) — API 安全阈值，超过则等比降采样 */
  MAX_EDGE_PX: 1568,
  /** 拿不到 display info 时假设的 Retina backing scale。Phase 2 用实测值替换，此常量留作 fallback */
  FALLBACK_SCALE_FACTOR: 2,
  /** sharp 降采样核 */
  RESIZE_KERNEL: 'lanczos3' as const,
} as const;

/** computer_batch 批处理配置 */
export const COMPUTER_BATCH = {
  /** 子动作间默认延迟 (ms)。0 = 完全保留现有无延迟行为 */
  DEFAULT_SETTLE_MS: 0,
  /** settleMs 上限，防止模型写出爆炸性的延迟 */
  MAX_SETTLE_MS: 5_000,
} as const;
