/**
 * 'event' 调度（N-TRIGGER-CHANNEL-EVENT）的护栏参数。
 *
 * 事件源只有本机已连接通道的入站消息（Feishu/Telegram via ChannelManager），
 * 不开端口、不挂 HTTP endpoint。这里的常量只管合批/限频/截断/去重的界。
 */
export const CRON_EVENT_TRIGGER = {
  /** 合批窗缺省（秒）：窗内到达的事件合并成一次 run。 */
  DEFAULT_BATCH_WINDOW_SEC: 10,
  /** 合批窗上限（秒）：再大的配置也被压到这里。 */
  MAX_BATCH_WINDOW_SEC: 300,
  /** 两次 run 的最小间隔缺省（秒）。 */
  DEFAULT_MIN_RUN_INTERVAL_SEC: 60,
  /** 两次 run 的最小间隔下限（秒）：再小的配置也被抬到这里，绝不放低。 */
  MIN_MIN_RUN_INTERVAL_SEC: 30,
  /** 单次 run 最多携带的事件条数；超出部分计入 droppedCount，不静默丢。 */
  MAX_EVENTS_PER_RUN: 20,
  /** 每任务待处理队列上限；超界挤出最旧并计数（下次 run 报告）。 */
  PENDING_QUEUE_MAX: 200,
  /** 单条消息文本截断长度（字符）。 */
  MAX_MESSAGE_CHARS: 2000,
  /** 发送者名称截断长度（字符）。 */
  MAX_SENDER_NAME_CHARS: 100,
  /** 整个 untrusted 事件块的截断长度（字符）。 */
  MAX_BLOCK_CHARS: 40_000,
  /** 跨任务去重集容量（key 已含订阅 id）。 */
  DEDUPE_MAX_ENTRIES: 4096,
  /** 上一趟 run 还没结束时合批重试的间隔：限频已放行但互斥未放行的场景，按 1s 探测。 */
  IN_FLIGHT_RETRY_MS: 1_000,
  /** untrusted 事件块的定界标签（闭合标签出现在载荷里会被转义）。 */
  UNTRUSTED_BLOCK_TAG: 'untrusted_channel_events',
} as const;
