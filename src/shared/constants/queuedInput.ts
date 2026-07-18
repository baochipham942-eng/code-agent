export const QUEUED_INPUT_RETRY = {
  /** 发送失败后允许重新排队的最大次数；是否耗尽只由 host 判定。 */
  MAX_RESEND_ATTEMPTS: 3,
} as const;
