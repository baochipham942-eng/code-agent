// ============================================================================
// Model Validator — 运行时一致性校验
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { PROVIDER_REGISTRY } from './providerRegistry';
import {
  DEFAULT_MODELS,
  CONTEXT_WINDOWS,
  MODEL_PRICING_PER_1M,
  VISION_MODEL_CAPABILITIES,
} from '../../shared/constants';

const logger = createLogger('ModelValidator');

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  checkedAt: string;
  registeredModelCount: number;
}

/**
 * 从 PROVIDER_REGISTRY 收集所有已注册模型 ID
 */
function collectRegisteredModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const provider of Object.values(PROVIDER_REGISTRY)) {
    for (const model of provider.models) {
      ids.add(model.id);
    }
  }
  return ids;
}

/**
 * 校验 constants.ts 与 providerRegistry.ts 的一致性
 *
 * 非阻塞：不匹配项仅 warn，不抛异常
 */
export function validateModelConsistency(): ValidationResult {
  const warnings: string[] = [];
  const registeredIds = collectRegisteredModelIds();

  // 1. DEFAULT_MODELS 所有条目 → 模型 ID 必须在 Registry 中
  for (const [role, modelId] of Object.entries(DEFAULT_MODELS)) {
    if (!registeredIds.has(modelId)) {
      warnings.push(`DEFAULT_MODELS.${role} = '${modelId}' 未在 PROVIDER_REGISTRY 中注册`);
    }
  }

  // 2. CONTEXT_WINDOWS 所有 key → 模型 ID 必须在 Registry 中
  for (const modelId of Object.keys(CONTEXT_WINDOWS)) {
    if (!registeredIds.has(modelId)) {
      warnings.push(`CONTEXT_WINDOWS['${modelId}'] 未在 PROVIDER_REGISTRY 中注册`);
    }
  }

  // 3. MODEL_PRICING_PER_1M 所有 key → 模型 ID 必须在 Registry 中（'default' 除外）
  for (const modelId of Object.keys(MODEL_PRICING_PER_1M)) {
    if (modelId === 'default') continue;
    if (!registeredIds.has(modelId)) {
      warnings.push(`MODEL_PRICING_PER_1M['${modelId}'] 未在 PROVIDER_REGISTRY 中注册`);
    }
  }

  // 4. VISION_MODEL_CAPABILITIES 所有 key → 模型 ID 必须在 Registry 中
  for (const modelId of Object.keys(VISION_MODEL_CAPABILITIES)) {
    if (!registeredIds.has(modelId)) {
      warnings.push(`VISION_MODEL_CAPABILITIES['${modelId}'] 未在 PROVIDER_REGISTRY 中注册`);
    }
  }

  // 输出结果
  const valid = warnings.length === 0;
  if (valid) {
    logger.info('模型一致性校验通过', { registeredModelCount: registeredIds.size });
  } else {
    for (const w of warnings) {
      logger.warn(`[ModelValidator] ${w}`);
    }
    logger.warn(`模型一致性校验发现 ${warnings.length} 处不匹配`, {
      registeredModelCount: registeredIds.size,
    });
  }

  return {
    valid,
    warnings,
    checkedAt: new Date().toISOString(),
    registeredModelCount: registeredIds.size,
  };
}

/**
 * 可选：HEAD 请求探测默认模型端点可达性
 * 3s 超时，fire-and-forget，仅日志
 */
export async function probeDefaultModel(): Promise<void> {
  try {
    const https = await import('https');
    const { MODEL_API_ENDPOINTS, DEFAULT_PROVIDER } = await import('../../shared/constants');
    const endpoint = MODEL_API_ENDPOINTS[DEFAULT_PROVIDER as keyof typeof MODEL_API_ENDPOINTS];
    if (!endpoint) {
      logger.debug('probeDefaultModel: 无法获取默认 provider 端点');
      return;
    }

    const url = new URL(endpoint);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'HEAD',
        timeout: 3000,
      },
      (res) => {
        logger.debug('probeDefaultModel: 端点可达', {
          provider: DEFAULT_PROVIDER,
          status: res.statusCode,
        });
      },
    );
    req.on('error', (err) => {
      logger.debug('probeDefaultModel: 端点不可达', {
        provider: DEFAULT_PROVIDER,
        error: (err as Error).message,
      });
    });
    req.on('timeout', () => {
      req.destroy();
      logger.debug('probeDefaultModel: 端点超时');
    });
    req.end();
  } catch {
    // fire-and-forget
  }
}
