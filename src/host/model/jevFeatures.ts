// ============================================================================
// Jev（TypeSafe System One）四特性开关单源 —— 默认开 + 无 key 静默降级
// ----------------------------------------------------------------------------
// N-JEV-DEFAULT-ON：CODE_AGENT_PERMISSION_LLM_CLASSIFIER / CODE_AGENT_JEV_INJECTION_SCAN /
// CODE_AGENT_JEV_COMPACTION / CODE_AGENT_JEV_ROUTER 默认开（unset = on；
// '0' / 'false'，trim 后大小写不敏感 = off；其余任意值 = on）。
// 运行时没有可用 key（resolveJevRoute() === null）时对应特性静默降级为关：
// 不向用户报错、每特性每进程至多一条 warn、降级计数经 diagnostics jevStatus 可观测。
// key 只在这里探测（providerResolution/configService），本模块永不持有或外发 key 本体。
// 测试注入的 systemOne 替身在各站点用 ?? 优先注入，天然绕过 key 检查。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { JevSystemOneCall } from '../../shared/constants/jevQuestions';
import { resolveJevRoute } from './providers/typesafeProvider';

const logger = createLogger('JevFeatures');

export type JevFeature = 'permissionClassifier' | 'injectionScan' | 'compaction' | 'router';

/** 特性 → 环境变量名（唯一登记处，新特性只在这里加）。 */
const JEV_FEATURE_ENV_FLAGS: Record<JevFeature, string> = {
  permissionClassifier: 'CODE_AGENT_PERMISSION_LLM_CLASSIFIER',
  injectionScan: 'CODE_AGENT_JEV_INJECTION_SCAN',
  compaction: 'CODE_AGENT_JEV_COMPACTION',
  router: 'CODE_AGENT_JEV_ROUTER',
};

/**
 * 特性开关判定：unset = on；'0' / 'false'（trim 后大小写不敏感）= off；其余 = on。
 * 每次调用重读 env，不做模块级缓存（与原四站点逐调用读取的口径一致）。
 */
export function isJevFeatureOn(feature: JevFeature, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[JEV_FEATURE_ENV_FLAGS[feature]];
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

const degradedCounts: Record<JevFeature, number> = {
  permissionClassifier: 0,
  injectionScan: 0,
  compaction: 0,
  router: 0,
};
const degradedWarned = new Set<JevFeature>();

/** 无 key 降级：计数逐次累加，warn 每特性每进程只留一条（可区分到具体 flag）。 */
function missingKeyError(feature: JevFeature): Error & { code: string } {
  degradedCounts[feature] += 1;
  if (!degradedWarned.has(feature)) {
    degradedWarned.add(feature);
    logger.warn(
      `${JEV_FEATURE_ENV_FLAGS[feature]} 已开启但 TYPESAFE_API_KEY 与 OpenRouter key 均未配置，`
      + `Jev ${feature} 静默降级为关（本进程仅此一条）`,
    );
  }
  const error = new Error('[typesafe] TYPESAFE_API_KEY and OpenRouter key are both unset') as Error & { code: string };
  error.code = 'TYPESAFE_KEY_MISSING';
  return error;
}

/**
 * 生产 systemOne 包装：每次调用重探 route（设置里后补的 key 无需重启即生效）。
 * 无 key 时不触达 provider 调用面（systemOne 只在有 key 时才动态装载），抛
 * code=TYPESAFE_KEY_MISSING 的 Error 交站点回落。
 */
export function createProductionJevCall(feature: JevFeature): JevSystemOneCall {
  return async (state, questions, options) => {
    if (resolveJevRoute() === null) throw missingKeyError(feature);
    const { systemOne } = await import('./providers/typesafeProvider');
    return systemOne(state, questions, options);
  };
}

export interface JevStatus {
  keyConfigured: boolean;
  route: 'official' | 'openrouter' | null;
  features: Record<JevFeature, {
    flagOn: boolean;
    effective: boolean;
    degradedCount: number;
  }>;
}

/** 诊断快照（diagnostics jevStatus）：只读，永不包含 key 材料。 */
export function getJevStatus(): JevStatus {
  const route = resolveJevRoute();
  const keyConfigured = route !== null;
  const features = {} as JevStatus['features'];
  for (const feature of Object.keys(JEV_FEATURE_ENV_FLAGS) as JevFeature[]) {
    const flagOn = isJevFeatureOn(feature);
    features[feature] = {
      flagOn,
      effective: flagOn && keyConfigured,
      degradedCount: degradedCounts[feature],
    };
  }
  return { keyConfigured, route: route?.kind ?? null, features };
}
