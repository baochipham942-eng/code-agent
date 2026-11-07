// ============================================================================
// Config Service 内部常量 + 纯函数 —— 从 configService.ts 抽出的模块级 helper
// （无实例状态），以保持该模块在 eslint max-lines 预算内。行为零变化，仅做机械
// 搬移。isProduction/sanitizeForLogging/safeLog 由 configService.ts re-export，
// 消费方（services/core barrel、vi.mock 该模块的测试）导入路径不变。
// ============================================================================

import path from 'path';
import { app } from '../../platform';
import { createLogger } from '../infra/logger';
import { devSlotFromDataDirName } from '../../../shared/devSlot';

const logger = createLogger('ConfigService');

// config.json 外部编辑热重载:与 soulLoader/skillWatcher 一致的去抖窗口
export const CONFIG_WATCH_DEBOUNCE_MS = 500;
// save() 自身写盘后的静默窗口,避免本进程写入触发热重载回环
export const CONFIG_SELF_WRITE_WINDOW_MS = 1500;
export const SHARED_SEARCH_SERVICE_KEYS = ['brave', 'exa', 'firecrawl', 'openai', 'perplexity', 'tavily'] as const;
// 接受托管 key 的内置 provider 白名单（先开 xiaomi/MiMo；控制面下发清单之外的一律拒收）
export const SHARED_MODEL_PROVIDER_KEYS = ['xiaomi'] as const;
const DISCLOSURE_LEVELS = ['simple', 'standard', 'advanced', 'expert'] as const;
type PersistedDisclosureLevel = (typeof DISCLOSURE_LEVELS)[number];

export function isPersistedDisclosureLevel(value: unknown): value is PersistedDisclosureLevel {
  return typeof value === 'string' && (DISCLOSURE_LEVELS as readonly string[]).includes(value);
}

/**
 * Check if running in production (packaged app)
 */
export function isProduction(): boolean {
  return app?.isPackaged ?? process.env.NODE_ENV === 'production';
}

/**
 * devModeAutoApprove 只认 Rust dev_slot() 注入的数据目录身份。
 * release 构建的 Dev 测试包同样是 NODE_ENV=production，不能拿构建 profile 判通道。
 */
export function isDevSlotRuntime(dataDir = process.env.CODE_AGENT_DATA_DIR): boolean {
  const normalized = dataDir?.trim();
  if (!normalized) return false;
  return devSlotFromDataDirName(path.basename(normalized)) !== null;
}

/**
 * Sanitize sensitive data for logging
 * Masks API keys, tokens, and other sensitive strings
 */
export function sanitizeForLogging(value: unknown): unknown {
  if (typeof value === 'string') {
    // Mask API keys (sk-xxx, key-xxx, etc.)
    if (/^(sk-|key-|pk-|api-)/i.test(value)) {
      return value.slice(0, 7) + '***' + value.slice(-4);
    }
    // Mask JWTs
    if (value.includes('.') && value.split('.').length === 3 && value.length > 50) {
      return value.slice(0, 10) + '...[JWT]...' + value.slice(-10);
    }
    // Mask long hex strings (potential keys/tokens)
    if (/^[a-f0-9]{32,}$/i.test(value)) {
      return value.slice(0, 8) + '***' + value.slice(-4);
    }
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map(sanitizeForLogging);
    }
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Always mask keys with sensitive names
      if (/key|token|secret|password|credential|auth/i.test(k)) {
        sanitized[k] = typeof v === 'string' ? sanitizeForLogging(v) : '[REDACTED]';
      } else {
        sanitized[k] = sanitizeForLogging(v);
      }
    }
    return sanitized;
  }

  return value;
}

/**
 * Safe console.log that automatically sanitizes sensitive data
 */
export function safeLog(message: string, ...args: unknown[]): void {
  logger.info(message, ...args.map(sanitizeForLogging));
}

/**
 * 模型 provider → 环境变量 key 映射（ConfigService.getApiKey 的 env 兜底表）。
 * 从方法内局部常量机械搬移，内容逐字不变。
 */
export const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  local: '',
  zhipu: 'ZHIPU_API_KEY',
  qwen: 'QWEN_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  grok: 'GROK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  volcengine: 'VOLCENGINE_API_KEY',
  longcat: 'LONGCAT_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  custom: 'CUSTOM_PROVIDER_API_KEY',
};

/**
 * 非模型服务 → 环境变量 key 映射（ConfigService.getServiceApiKey 的 env 兜底表）。
 * 从方法内局部常量机械搬移，内容逐字不变。
 */
export const SERVICE_ENV_KEY_MAP: Record<string, string> = {
  brave: 'BRAVE_API_KEY',
  langfuse_public: 'LANGFUSE_PUBLIC_KEY',
  langfuse_secret: 'LANGFUSE_SECRET_KEY',
  github: 'GITHUB_TOKEN',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  exa: 'EXA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  tavily: 'TAVILY_API_KEY',
  // 外部搜索源的独立搜索凭据（与 zhipu/minimax 模型 key 是两把，故意不复用）。
  'zhipu-search': 'ZHIPU_OFFICIAL_API_KEY',
  'minimax-search': 'MINIMAX_SEARCH_API_KEY',
  skillsmp: 'SKILLSMP_API_KEY',
  'neo-share': 'NEO_SHARE_UPLOAD_TOKEN',
  'neo-cron-cloud': 'NEO_CRON_CLOUD_TOKEN',
  typesafe: 'TYPESAFE_API_KEY',
};
