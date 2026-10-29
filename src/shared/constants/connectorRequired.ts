/** 连接卡等待连接完成：CLI/SaaS 连接器没有推送，只能轮询 oauthStatus。 */
export const CONNECTOR_REQUIRED_POLL = {
  /** 轮询间隔。 */
  INTERVAL_MS: 3_000,
  /** 单张卡最多轮询次数（约 5 分钟），到顶后停轮询并露出手动「我已连好，继续」。 */
  MAX_POLLS: 100,
} as const;
