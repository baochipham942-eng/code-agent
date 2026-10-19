// ============================================================================
// Jev（TypeSafe System One）判断面跨端契约（N-JEV-DEFAULT-ON-CONSENT）
// ----------------------------------------------------------------------------
// diagnostics jevStatus 快照的形状：host 产出（model/jevFeatures.ts），renderer 设置页
// 消费（JevKeyConfig）。key 材料永不进入本形状——只有来源类别与降级计数。
// ============================================================================

/**
 * Jev key 来源/状态（五态互斥）：
 * - official / openrouter：路由可用（openrouter = 已获用户同意的借用）
 * - openrouter_pending_consent：检测到 OpenRouter key 但用户尚未允许借用（视同无 key）
 * - disabled_by_user：用户在设置里关了 Jev 总开关（视同无 key）
 * - none：两把 key 都没配置
 */
export type JevKeySource =
  | 'official'
  | 'openrouter'
  | 'openrouter_pending_consent'
  | 'disabled_by_user'
  | 'none';

/** Jev 参与的四特性（与 jevFeatures 的 flag 登记表一一对应）。 */
export type JevFeature = 'permissionClassifier' | 'injectionScan' | 'compaction' | 'router';

export interface JevStatus {
  /** 是否存在可用路由（official / openrouter）。 */
  keyConfigured: boolean;
  /** 可用路由类别；不可用时 null。 */
  route: 'official' | 'openrouter' | null;
  /** 五态来源（含「检测到但未允许」「用户关闭」这两个不可用但可解释的状态）。 */
  keySource: JevKeySource;
  features: Record<JevFeature, {
    /** 环境变量开关是否开（unset = on）。 */
    flagOn: boolean;
    /** flag 开且有可用路由。 */
    effective: boolean;
    /** 本进程因路由不可用而降级的次数。 */
    degradedCount: number;
  }>;
}
