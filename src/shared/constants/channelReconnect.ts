/**
 * 通道账号连接失败后的自动重连（N-FEISHU-WS-FIRST-RETRY）。
 * 首次握手超时 / 网络未就绪时，ChannelManager 按账号指数退避重连：
 * 次数不限，成功清零；用户手动断开（disconnect / update / delete / shutdown）即取消。
 */
export const CHANNEL_CONNECT_RETRY = {
  /** 第 1 次重试等待 30s，之后逐次翻倍 */
  INITIAL_DELAY_MS: 30_000,
  /** 退避封顶 15 分钟 */
  MAX_DELAY_MS: 900_000,
} as const;

/**
 * 睡眠唤醒 / 网络恢复探测：一个 unref 的 interval tick 同时做两件事——
 * tick 间隔的墙钟差远大于间隔本身视为系统唤醒；对挂起重试的账号的平台域名做
 * 轻量 DNS 探测，结果从失败翻转为成功时立即重试一次。
 */
export const CHANNEL_RECOVERY_PROBE = {
  TICK_INTERVAL_MS: 5_000,
  /** 墙钟差超过 间隔×该系数 判定为唤醒（正常调度抖动远小于此） */
  WAKE_GAP_FACTOR: 3,
} as const;

/** 测试 / 联调可缩短重试起始等待（正整数毫秒，解析失败回退常量默认值） */
export const CHANNEL_CONNECT_RETRY_INITIAL_MS_ENV = 'NEO_CHANNEL_CONNECT_RETRY_INITIAL_MS';
