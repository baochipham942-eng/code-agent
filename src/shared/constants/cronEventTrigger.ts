/**
 * 'event' 调度（N-TRIGGER-CHANNEL-EVENT）的护栏参数。
 *
 * 事件源目前有两类：本机已连接通道的入站消息（Feishu/Telegram via ChannelManager），
 * 以及本地连接器轮询（N-TRIGGER-CONNECTOR-MAIL 的 macOS Mail）。不开端口、不挂
 * HTTP endpoint。这里的常量只管合批/限频/轮询/截断/去重的界。
 */
export const CRON_EVENT_TRIGGER = {
  /**
   * 事件任务单次预算缺省（USD）：/schedule 确认卡与群监听模板的预填值
   * （owner 裁定 10-14：预填 0.5、可改），业务代码不写 0.5 字面量。
   */
  DEFAULT_RUN_BUDGET_USD: 0.5,
  /** 群监听自检窗口（分钟）；只观察用户主动发送的消息。 */
  GROUP_LISTEN_CHECK_MINUTES: 2,
  GROUP_LISTEN_CHECK_POLL_MS: 1_000,
  /** 合批窗缺省（秒）：窗内到达的事件合并成一次 run。 */
  DEFAULT_BATCH_WINDOW_SEC: 10,
  /** 合批窗上限（秒）：再大的配置也被压到这里。 */
  MAX_BATCH_WINDOW_SEC: 300,
  /** 两次 run 的最小间隔缺省（秒）。 */
  DEFAULT_MIN_RUN_INTERVAL_SEC: 60,
  /** 两次 run 的最小间隔下限（秒）：再小的配置也被抬到这里，绝不放低。 */
  MIN_MIN_RUN_INTERVAL_SEC: 30,
  /** mail 源轮询间隔缺省（秒）。 */
  DEFAULT_POLL_INTERVAL_SEC: 60,
  /** mail 源轮询间隔下限（秒）：再小的配置也被抬到这里。 */
  MIN_POLL_INTERVAL_SEC: 30,
  /** mail 源缺省监听的邮箱名（Apple Mail 收件箱）。 */
  DEFAULT_MAILBOX: 'INBOX',
  /** mail 源单次轮询拉取的邮件条数上限（list_messages 的 limit）。 */
  MAIL_POLL_LIST_LIMIT: 25,
  /** mail 轮询扫描 tick（毫秒）：到期任务的轮询由这个粒度驱动（任务增删改即时生效）。 */
  MAIL_POLL_TICK_MS: 5_000,
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

/**
 * 事件自动化「观察档」与逐事件决策台账（N-TRIGGER-OBSERVE-MODE）的界。
 * 台账按任务有界（保留最近 N 条），理由/摘要按字符截断。
 */
export const CRON_EVENT_DECISIONS = {
  /** 每个自动化保留的最近决策条数缺省（N 可由 recordCronEventDecisions 的 maxPerJob 覆盖）。 */
  DEFAULT_MAX_PER_JOB: 500,
  /** 读接口单次返回条数上限。 */
  MAX_READ_LIMIT: 500,
  /** 一行理由的截断长度（字符）。 */
  MAX_REASON_CHARS: 200,
  /** 「本会发出什么」摘要的截断长度（字符）。 */
  MAX_SUMMARY_CHARS: 200,
  /** 每任务挂起待记的 dropped 事件 id 上限（超出只计数，不逐条记）。 */
  MAX_PENDING_DROPPED_IDS: 500,
  /** 模型逐事件陈述决策的标签名（只在事件触发的 run 里要求）。 */
  DECISION_TAG: 'cron_event_decision',
  /** 观察档拦截后回给工具调用方的结果文案前缀（模型可见）。 */
  OBSERVE_RECORDED_TEXT: 'recorded, not executed (observe mode)',
} as const;
