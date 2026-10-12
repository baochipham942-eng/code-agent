/**
 * pptx 逐页预览截图缓存（<dataDir>/cache/presentation-page-previews/<revision>/）的保留策略。
 *
 * 背景：每次编辑 deck 都会算出新 revision 并落一个新目录，旧目录此前没有任何回收路径。
 * 阈值只在这里出现，sweep（src/host/services/infra/presentationPreviewRetention.ts）引用。
 */
export const PRESENTATION_PREVIEW_RETENTION = {
  /** lastUsedAt 距今超过该时长未再命中缓存的 revision 目录可回收 */
  UNUSED_MS: 30 * 24 * 60 * 60 * 1000,
  /** 每个 deck（manifest.filePath 相同）额外保留的最新 revision 目录数 */
  KEEP_REVISIONS_PER_DECK: 3,
  /** 超出保留数之后的较短保留期（防最近编辑历史被立刻清掉） */
  EXCESS_MS: 7 * 24 * 60 * 60 * 1000,
  /** 启动首扫之后的周期扫描间隔 */
  SWEEP_INTERVAL_MS: 24 * 60 * 60 * 1000,
} as const;
