/**
 * 三个 app 自有缓存目录（channel-media / 托管浏览器截图 / appshots）的保留策略。
 *
 * 背景：这三个目录此前只有写入方、没有任何回收路径，会无限增长；托管浏览器截图
 * 还是敏感页面捕捉，不应久留。阈值只在这里出现，sweep
 * （src/host/services/infra/appCacheRetention.ts）引用。
 */
export const APP_CACHE_RETENTION = {
  /**
   * 飞书/lark 消息媒体转存（<dataDir>/cache/channel-media/<platform>/<account>/）：
   * 消息附件可按 file_key 重新下载，60 天后未再被引用即可回收。
   */
  CHANNEL_MEDIA_MAX_AGE_MS: 60 * 24 * 60 * 60 * 1000,
  /** 同目录总量上限 2 GB：超出后从未引用的最旧文件开始回收 */
  CHANNEL_MEDIA_MAX_TOTAL_BYTES: 2 * 1024 * 1024 * 1024,
  /**
   * 托管浏览器页面截图（<userData>/screenshots）：敏感页面捕捉不应久留，30 天即回收
   * （只动 *.png，storage_state_*.json 永不触碰）。
   */
  SCREENSHOT_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
  /** 同目录总量上限 1 GB：截图是整页 PNG，比消息媒体更容易堆满磁盘 */
  SCREENSHOT_MAX_TOTAL_BYTES: 1 * 1024 * 1024 * 1024,
  /**
   * appshots 窗口捕捉（<dataDir>/appshots）：用户热键触发的整窗快照、被会话按
   * attachment id 引用，保留期放最长（90 天）。
   */
  APPSHOT_MAX_AGE_MS: 90 * 24 * 60 * 60 * 1000,
  /** 同目录总量上限 2 GB */
  APPSHOT_MAX_TOTAL_BYTES: 2 * 1024 * 1024 * 1024,
  /**
   * 删除地板：写入不足 24 h 的文件一律不动——刚落盘的文件大概率正被本轮会话引用，
   * 也避免删掉正在写入的半成品。
   */
  MIN_AGE_MS: 24 * 60 * 60 * 1000,
  /** 启动首扫之后的周期扫描间隔（每天一轮） */
  SWEEP_INTERVAL_MS: 24 * 60 * 60 * 1000,
} as const;
