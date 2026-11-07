// ============================================================================
// Jev（TypeSafe System One）判断面跨端契约（N-JEV-DEFAULT-ON-CONSENT）
// ----------------------------------------------------------------------------
// diagnostics jevStatus 快照的形状：host 产出（model/jevFeatures.ts），renderer 设置页
// 消费（JevKeyConfig）。key 材料永不进入本形状——只有来源类别与降级计数。
// ============================================================================

/**
 * Jev key 来源/状态（六态互斥）：
 * - official / openrouter / neo_hosted：路由可用（openrouter = 已获用户同意的借用；
 *   neo_hosted = Neo 出钱的云端判官代理，key 只在服务端，N-JEV-NEO-KEY）
 * - openrouter_pending_consent：检测到 OpenRouter key 但用户尚未允许借用（视同无 key）
 * - disabled_by_user：用户在设置里关了 Jev 总开关（视同无 key）
 * - none：两把 key 都没配置（含「已登录但未开云判官」等不可用情形）
 */
export type JevKeySource =
  | 'official'
  | 'openrouter'
  | 'neo_hosted'
  | 'openrouter_pending_consent'
  | 'disabled_by_user'
  | 'none';

/**
 * Neo 托管判官的退避原因：限流两码（429/503）+ 持续性服务故障（401/404/5xx/网络/超时，
 * 云端漏配或未部署时短退避，避免每次判官调用都先付一次云端往返）。
 */
export type JevHostedBlockReason = 'user_daily_limit' | 'global_fuse' | 'service_unavailable';

/** Neo 托管判官的 per-process 退避状态（触发后到点前不再发起调用，避免刷 429）。 */
export interface JevHostedBlockState {
  /** epoch ms；在此之前托管路由不可用。 */
  blockedUntil: number;
  blockReason: JevHostedBlockReason;
}

/** Neo 托管判官的状态切片（getJevStatus.hosted）：资格 + 限流退避。 */
export interface JevHostedStatus {
  /**
   * 是否具备托管资格（无自有 key、总开关开、已登录）。含「云判官子开关已关」的
   * 情形——设置页据此保留子开关行，关掉后还能再打开。
   */
  eligible: boolean;
  /** 退避到点（epoch ms）；未在退避为 null。 */
  blockedUntil: number | null;
  blockReason: JevHostedBlockReason | null;
}

/** Jev 参与的四特性（与 jevFeatures 的 flag 登记表一一对应）。 */
export type JevFeature = 'permissionClassifier' | 'injectionScan' | 'compaction' | 'router';

export interface JevStatus {
  /** 是否存在可用路由（official / openrouter / 未被限流的 neo_hosted）。 */
  keyConfigured: boolean;
  /** 可用路由类别；不可用时 null。 */
  route: 'official' | 'openrouter' | 'neo_hosted' | null;
  /** 六态来源（含「检测到但未允许」「用户关闭」这两个不可用但可解释的状态）。 */
  keySource: JevKeySource;
  /**
   * Neo 托管判官状态切片：具备托管资格（含子开关关）时出现；设置页据此显示
   * 云判官子开关与「今日额度已用完/云判官不可用」状态行。
   */
  hosted?: JevHostedStatus;
  features: Record<JevFeature, {
    /** 环境变量开关是否开（unset = on）。 */
    flagOn: boolean;
    /** flag 开且有可用路由。 */
    effective: boolean;
    /** 本进程因路由不可用而降级的次数。 */
    degradedCount: number;
  }>;
}
