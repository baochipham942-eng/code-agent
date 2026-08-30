// ============================================================================
// Quick Model Service - Provides fast, cheap AI for simple tasks
// ============================================================================
// Uses the quick model (cheapest, fastest) for simple operations:
// - Format conversion
// - Quick classification
// - Simple transformations
// - Yes/No decisions
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { DEFAULT_MODELS, MODEL_API_ENDPOINTS, MODEL_FEATURES, QUICK_MODEL_AUTH_BLACKLIST_MS } from '../../shared/constants';
import { getConfigService } from '../services/core/configService';
import { getProviderLimiter } from './concurrencyLimiter';
import { isZhipuFreeModel, resolveProviderApiKey, resolveProviderBaseUrl } from './providers/providerResolution';
import { getMemoryModelOverride, type MemoryModelOverride } from './memoryModelOverrideScope';
import type { ModelConfig, ModelProvider } from '../../shared/contract';

const logger = createLogger('QuickModel');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface QuickModelResult {
  success: boolean;
  content?: string;
  error?: string;
  authFailed?: boolean;
  failureReason?: QuickModelFailureReason;
  status?: number;
  provider?: string;
  model?: string;
  attempts?: number;
}

export type QuickModelFailureReason =
  | 'not_configured'
  | 'limiter_unavailable'
  | 'rate_limited'
  | 'server_error'
  | 'http_error'
  | 'auth_failed'
  | 'invalid_response'
  | 'empty_response'
  | 'transport_error';

export interface QuickModelAuthFailure {
  provider: string;
  model: string;
  status: number;
  at: number;
}

export interface QuickModelFailure {
  provider?: string;
  model?: string;
  failureReason: QuickModelFailureReason;
  status?: number;
  at: number;
}

export interface ClassificationResult {
  category: string;
  confidence: number;
  reasoning?: string;
}

// ----------------------------------------------------------------------------
// Quick Model Service
// ----------------------------------------------------------------------------

interface QuickModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
  /** thinking 模型（如 mimo）当 quick model 时需关闭思考，否则短输出额度被 reasoning 吃光返回空 */
  disableThinking: boolean;
  routeSource: 'memory' | 'fast' | 'code' | 'env';
}

let quickModelAuthFailure: QuickModelAuthFailure | null = null;
let quickModelFailure: QuickModelFailure | null = null;

// 鉴权失败拉黑表：key = provider:model:key指纹（指纹=长度+末4位，不存整 key）。
// 「有一个失效的 key」不能比「没有 key」更糟：401/403 后该候选在窗口内不再入选，
// 解析降到下一级；换 key 指纹即变 → 立即恢复重试。
const quickAuthBlacklist = new Map<string, number>();
// 每次调用都重解析（getSettings 是内存读，成本远小于随后的 LLM 请求），
// 只在解析结果变化时打 info，恒定结果不刷屏。
const lastResolvedLogKeys: Partial<Record<'quick' | 'memory', string>> = {};

function blacklistKey(provider: string, model: string, apiKey: string): string {
  return `${provider}:${model}:${apiKey.length}:${apiKey.slice(-4)}`;
}

function isAuthBlacklisted(provider: string, model: string, apiKey: string): boolean {
  const key = blacklistKey(provider, model, apiKey);
  const at = quickAuthBlacklist.get(key);
  if (at === undefined) return false;
  if (Date.now() - at >= QUICK_MODEL_AUTH_BLACKLIST_MS) {
    quickAuthBlacklist.delete(key);
    return false;
  }
  return true;
}

export function getQuickModelAuthFailure(): QuickModelAuthFailure | null {
  return quickModelAuthFailure ? { ...quickModelAuthFailure } : null;
}

export function getQuickModelFailure(): QuickModelFailure | null {
  return quickModelFailure ? { ...quickModelFailure } : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseChatCompletionContent(payload: unknown): string | null {
  if (!isUnknownRecord(payload) || !isUnknownArray(payload.choices)) {
    return null;
  }

  const firstChoice = payload.choices[0];
  if (!isUnknownRecord(firstChoice) || !isUnknownRecord(firstChoice.message)) {
    return null;
  }

  const content = firstChoice.message.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

function parseChatCompletionDeltaContent(payload: unknown): string | null {
  if (!isUnknownRecord(payload) || !isUnknownArray(payload.choices)) {
    return null;
  }

  const firstChoice = payload.choices[0];
  if (!isUnknownRecord(firstChoice) || !isUnknownRecord(firstChoice.delta)) {
    return null;
  }

  const content = firstChoice.delta.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

type QuickModelResponseParseResult =
  | { kind: 'content'; content: string }
  | { kind: 'empty' }
  | { kind: 'invalid'; error: string };

function parseSseChatCompletion(rawBody: string): QuickModelResponseParseResult {
  const events = rawBody.replace(/\r\n/g, '\n').split(/\n\n+/);
  const deltaParts: string[] = [];
  const completeMessages: string[] = [];
  let jsonEventCount = 0;
  let malformedEventCount = 0;

  for (const event of events) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
      jsonEventCount++;
    } catch {
      malformedEventCount++;
      continue;
    }

    const delta = parseChatCompletionDeltaContent(payload);
    if (delta) {
      deltaParts.push(delta);
      continue;
    }
    const completeMessage = parseChatCompletionContent(payload);
    if (completeMessage) completeMessages.push(completeMessage);
  }

  if (deltaParts.length > 0) {
    return { kind: 'content', content: deltaParts.join('') };
  }
  const completeMessage = completeMessages.at(-1);
  if (completeMessage) {
    return { kind: 'content', content: completeMessage };
  }
  if (jsonEventCount > 0) return { kind: 'empty' };
  return {
    kind: 'invalid',
    error: malformedEventCount > 0
      ? 'Quick model returned malformed SSE data'
      : 'Quick model returned an invalid SSE response',
  };
}

async function parseQuickModelResponse(response: Response): Promise<QuickModelResponseParseResult> {
  const rawBody = await response.text();
  const trimmedBody = rawBody.trimStart();
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream') || trimmedBody.startsWith('data:')) {
    return parseSseChatCompletion(rawBody);
  }
  if (!trimmedBody) return { kind: 'empty' };

  let payload: unknown;
  try {
    payload = JSON.parse(trimmedBody);
  } catch {
    return { kind: 'invalid', error: 'Quick model returned invalid JSON' };
  }
  const content = parseChatCompletionContent(payload);
  return content ? { kind: 'content', content } : { kind: 'empty' };
}

function isThinkingModel(model: string): boolean {
  return (MODEL_FEATURES[model] ?? []).includes('reasoning');
}

function isProviderExplicitlyDisabled(provider: string): boolean {
  try {
    return getConfigService().getSettings().models.providers?.[provider]?.enabled === false;
  } catch {
    return false;
  }
}

function getConfiguredProviderBaseUrl(provider: string): string | undefined {
  try {
    return getConfigService().getSettings().models.providers?.[provider]?.baseUrl;
  } catch {
    return undefined;
  }
}

/**
 * 把一个路由角色（provider + model）解析成 quick model config。
 * 拿不到 API key 或 endpoint 时返回 null（交由上层回落）。
 * 智谱免费档走官方端点 bigmodel.cn（0ki 代理不稳定支持免费 ID）。
 */
function resolveRole(
  provider: string,
  model: string,
  routeSource: QuickModelConfig['routeSource'],
): QuickModelConfig | null {
  if (isProviderExplicitlyDisabled(provider)) return null;

  const identityConfig = { provider: provider as ModelProvider, model } as ModelConfig;
  const modelConfig = {
    provider: provider as ModelProvider,
    model,
    baseUrl: isZhipuFreeModel(identityConfig) ? undefined : getConfiguredProviderBaseUrl(provider),
  } as ModelConfig;
  const apiKey = resolveProviderApiKey(modelConfig, { trustConfigKey: false });
  if (!apiKey) return null;
  if (isAuthBlacklisted(provider, model, apiKey)) return null;

  const baseUrl = resolveProviderBaseUrl({ ...modelConfig, apiKey });
  if (!baseUrl) return null;

  return { apiKey, baseUrl, model, provider, disableThinking: isThinkingModel(model), routeSource };
}

function resolveMemoryOverride(override: MemoryModelOverride): QuickModelConfig | null {
  if (isProviderExplicitlyDisabled(override.provider)) return null;
  const modelConfig = {
    provider: override.provider as ModelProvider,
    model: override.model,
    apiKey: override.apiKey,
    baseUrl: override.baseUrl,
  } as ModelConfig;
  const apiKey = override.apiKey ?? resolveProviderApiKey(modelConfig, { trustConfigKey: false });
  if (!apiKey || isAuthBlacklisted(override.provider, override.model, apiKey)) return null;
  const baseUrl = override.baseUrl ?? resolveProviderBaseUrl({ ...modelConfig, apiKey });
  if (!baseUrl) return null;
  return {
    apiKey,
    baseUrl,
    model: override.model,
    provider: override.provider,
    disableThinking: isThinkingModel(override.model),
    routeSource: 'memory',
  };
}

function pushUniqueCandidate(resolved: QuickModelConfig[], candidate: QuickModelConfig | null): void {
  if (!candidate) return;
  if (resolved.some((current) => (
    current.provider === candidate.provider
    && current.model === candidate.model
    && current.apiKey === candidate.apiKey
  ))) return;
  resolved.push(candidate);
}

/**
 * 解析 quick model（策略化）：
 *  1) 优先专用快模型 `routing.fast`（常态 = 智谱 glm-4.x-flash，0.5s，最省成本）
 *  2) 无专用快模型 key → 回落主模型 `routing.code`（如 mimo）；thinking 模型自动关思考
 *  3) config 路径完全失败 → 兜底直连智谱官方（历史行为）
 *  4) 都拿不到 → null（调用方：intent 走关键词兜底，其余 quick 任务 skip）
 */
function initializeQuickModelCandidates(route: 'quick' | 'memory' = 'quick'): QuickModelConfig[] {
  const resolved: QuickModelConfig[] = [];
  try {
    if (route === 'memory') {
      const override = getMemoryModelOverride();
      if (override) pushUniqueCandidate(resolved, resolveMemoryOverride(override));
    }
    const routing = getConfigService().getSettings().models.routing;
    if (route === 'memory' && routing.memory) {
      pushUniqueCandidate(
        resolved,
        resolveRole(routing.memory.provider, routing.memory.model, 'memory'),
      );
    }
    pushUniqueCandidate(resolved, resolveRole(routing.fast.provider, routing.fast.model, 'fast'));
    pushUniqueCandidate(resolved, resolveRole(routing.code.provider, routing.code.model, 'code'));
  } catch (error) {
    logger.warn(`${route === 'memory' ? 'Memory' : 'Quick'} model config resolution failed, falling back to env`, {
      error: String(error),
    });
  }

  if (resolved.length === 0) {
    const apiKey = process.env.ZHIPU_OFFICIAL_API_KEY || process.env.ZHIPU_API_KEY;
    if (!isProviderExplicitlyDisabled('zhipu') && apiKey && !isAuthBlacklisted('zhipu', DEFAULT_MODELS.quick, apiKey)) {
      resolved.push({
        apiKey,
        baseUrl: MODEL_API_ENDPOINTS.zhipuOfficial,
        model: DEFAULT_MODELS.quick,
        provider: 'zhipu',
        disableThinking: false,
        routeSource: 'env',
      });
    }
  }

  const [primary] = resolved;
  if (!primary) {
    logger.warn(route === 'memory'
      ? 'Memory model unavailable: no memory-model key, no fast-model key, no main-model key, no Zhipu key'
      : 'Quick model unavailable: no fast-model key, no main-model key, no Zhipu key');
    delete lastResolvedLogKeys[route];
    return [];
  }

  const logKey = `${primary.routeSource}:${primary.provider}:${primary.model}`;
  if (logKey !== lastResolvedLogKeys[route]) {
    lastResolvedLogKeys[route] = logKey;
    const details = {
      provider: primary.provider,
      model: primary.model,
      disableThinking: primary.disableThinking,
    };
    logger.info(
      route === 'memory' ? 'Memory model resolved' : 'Quick model resolved',
      route === 'memory' ? { ...details, routeSource: primary.routeSource } : details,
    );
  }
  return resolved;
}

function initializeQuickModel(): QuickModelConfig | null {
  return initializeQuickModelCandidates()[0] ?? null;
}

function quickFailure(
  config: QuickModelConfig,
  failureReason: QuickModelFailureReason,
  error: string,
  extra: Pick<QuickModelResult, 'authFailed' | 'status'> = {},
): QuickModelResult {
  return {
    success: false,
    error,
    failureReason,
    provider: config.provider,
    model: config.model,
    ...extra,
  };
}

function trackQuickModelResult(result: QuickModelResult): QuickModelResult {
  if (result.success) {
    quickModelFailure = null;
    return result;
  }
  if (result.failureReason) {
    quickModelFailure = {
      provider: result.provider,
      model: result.model,
      failureReason: result.failureReason,
      status: result.status,
      at: Date.now(),
    };
  }
  return result;
}

function isRateLimitFailure(status: number, body: string): boolean {
  return status === 429
    || /(?:code\D*)?(?:1302|1305)|速率限制|访问量过大/u.test(body);
}

async function executeQuickAttempt(
  config: QuickModelConfig,
  prompt: string,
  effectiveMaxTokens: number,
  signal?: AbortSignal,
): Promise<QuickModelResult> {
  const limiter = getProviderLimiter(config.provider);

  try {
    await limiter?.acquire(signal);
  } catch (error) {
    return quickFailure(
      config,
      'limiter_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: effectiveMaxTokens,
      temperature: 0.1,
      stream: false,
    };
    if (config.disableThinking) {
      body.thinking = { type: 'disabled' };
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        quickAuthBlacklist.set(blacklistKey(config.provider, config.model, config.apiKey), Date.now());
        quickModelAuthFailure = {
          provider: config.provider,
          model: config.model,
          status: response.status,
          at: Date.now(),
        };
        logger.error('快模型鉴权失败，疑似 API Key 无效或已过期', {
          provider: config.provider,
          model: config.model,
          status: response.status,
        });
        return quickFailure(
          config,
          'auth_failed',
          `${response.status} 快模型鉴权失败：API Key 可能无效或已过期`,
          { authFailed: true, status: response.status },
        );
      }
      const responseBody = await response.text();
      if (isRateLimitFailure(response.status, responseBody)) {
        limiter?.onRateLimit();
        return quickFailure(
          config,
          'rate_limited',
          `${response.status} ${responseBody.slice(0, 200)}`,
          { status: response.status },
        );
      }
      if (response.status >= 500 && response.status <= 599) {
        return quickFailure(
          config,
          'server_error',
          `${response.status} ${responseBody.slice(0, 200)}`,
          { status: response.status },
        );
      }
      return quickFailure(
        config,
        'http_error',
        `${response.status} ${responseBody.slice(0, 200)}`,
        { status: response.status },
      );
    }

    quickModelAuthFailure = null;
    limiter?.onSuccess();
    const parsed = await parseQuickModelResponse(response);
    if (parsed.kind === 'content') {
      return { success: true, content: parsed.content, provider: config.provider, model: config.model };
    }
    if (parsed.kind === 'invalid') {
      logger.error('Quick model returned an invalid response shape', {
        provider: config.provider,
        model: config.model,
        status: response.status,
        contentType: response.headers.get('content-type'),
      });
      return quickFailure(
        config,
        'invalid_response',
        parsed.error,
        { status: response.status },
      );
    }
    return quickFailure(config, 'empty_response', 'Empty response from quick model');
  } catch (error) {
    logger.error('Quick task failed', { error });
    return quickFailure(
      config,
      'transport_error',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    limiter?.release();
  }
}

/**
 * Execute a quick task with the fast model
 *
 * @param prompt - The task prompt
 * @returns The result
 */
export async function quickTask(
  prompt: string,
  maxTokens?: number,
  signal?: AbortSignal,
): Promise<QuickModelResult> {
  const candidates = initializeQuickModelCandidates();
  const [primary] = candidates;
  if (!primary) {
    return trackQuickModelResult({
      success: false,
      error: 'Quick model not configured',
      failureReason: 'not_configured',
      attempts: 0,
    });
  }

  const effectiveMaxTokens = maxTokens ?? 512;
  // fast 过载/服务端异常时切 routing.code；只有一个候选时经同一 limiter/backoff 再试一次。
  const attempts = candidates.length > 1 ? candidates.slice(0, 2) : [primary, primary];
  for (const [index, config] of attempts.entries()) {
    const result = await executeQuickAttempt(config, prompt, effectiveMaxTokens, signal);
    const withAttempts = { ...result, attempts: index + 1 };
    if (withAttempts.success) return trackQuickModelResult(withAttempts);
    if (withAttempts.failureReason !== 'rate_limited' && withAttempts.failureReason !== 'server_error') {
      return trackQuickModelResult(withAttempts);
    }
    const next = attempts[index + 1];
    if (!next) return trackQuickModelResult(withAttempts);
    logger.info('Quick task retrying after transient failure', {
      failureReason: withAttempts.failureReason,
      fromProvider: config.provider,
      fromModel: config.model,
      toProvider: next.provider,
      toModel: next.model,
    });
  }
  return trackQuickModelResult(quickFailure(primary, 'transport_error', 'Quick task ended without an attempt'));
}

/**
 * Execute a memory organization task.
 *
 * Candidate order is routing.memory -> routing.fast -> routing.code ->
 * the historical Zhipu env fallback. When routing.memory is absent, the
 * prompt and model selection are identical to quickTask.
 */
export async function memoryTask(
  prompt: string,
  maxTokens?: number,
  signal?: AbortSignal,
): Promise<QuickModelResult> {
  const candidates = initializeQuickModelCandidates('memory');
  const [primary] = candidates;
  if (!primary) {
    return trackQuickModelResult({
      success: false,
      error: 'Memory model not configured',
      failureReason: 'not_configured',
      attempts: 0,
    });
  }

  const effectiveMaxTokens = maxTokens ?? 512;
  const attempts = candidates.length > 1 ? candidates.slice(0, 2) : [primary, primary];
  for (const [index, config] of attempts.entries()) {
    const result = await executeQuickAttempt(config, prompt, effectiveMaxTokens, signal);
    const withAttempts = { ...result, attempts: index + 1 };
    if (withAttempts.success) return trackQuickModelResult(withAttempts);
    if (withAttempts.failureReason !== 'rate_limited' && withAttempts.failureReason !== 'server_error') {
      return trackQuickModelResult(withAttempts);
    }
    const next = attempts[index + 1];
    if (!next) return trackQuickModelResult(withAttempts);
    logger.info('Memory task retrying after transient failure', {
      failureReason: withAttempts.failureReason,
      fromProvider: config.provider,
      fromModel: config.model,
      toProvider: next.provider,
      toModel: next.model,
    });
  }
  return trackQuickModelResult(quickFailure(primary, 'transport_error', 'Memory task ended without an attempt'));
}

/**
 * Quick yes/no decision
 *
 * @param question - The question to decide
 * @returns true for yes, false for no, null if unable to decide
 */
export async function quickDecision(question: string): Promise<boolean | null> {
  const prompt = `Answer the following question with only "yes" or "no", nothing else:
${question}`;

  const result = await quickTask(prompt);
  if (!result.success || !result.content) return null;

  const answer = result.content.toLowerCase().trim();
  if (answer.includes('yes')) return true;
  if (answer.includes('no')) return false;
  return null;
}

/**
 * Quick classification into predefined categories
 *
 * @param text - The text to classify
 * @param categories - The possible categories
 * @returns The classification result
 */
export async function quickClassify(
  text: string,
  categories: string[]
): Promise<ClassificationResult | null> {
  const prompt = `Classify the following text into exactly ONE of these categories: ${categories.join(', ')}

Text: "${text}"

Respond with only the category name, nothing else.`;

  const result = await quickTask(prompt);
  if (!result.success || !result.content) return null;

  const answer = result.content.trim().toLowerCase();

  // Find best matching category
  for (const category of categories) {
    if (answer.includes(category.toLowerCase())) {
      return { category, confidence: 0.9 };
    }
  }

  // If no exact match, use the first word of the response
  const firstWord = answer.split(/\s+/)[0];
  for (const category of categories) {
    if (category.toLowerCase().startsWith(firstWord)) {
      return { category, confidence: 0.6 };
    }
  }

  return null;
}

/**
 * Quick text extraction/transformation
 *
 * @param text - The source text
 * @param instruction - What to extract/transform
 * @returns The extracted/transformed text
 */
export async function quickExtract(
  text: string,
  instruction: string
): Promise<string | null> {
  const prompt = `${instruction}

Text: "${text}"

Provide only the extracted/transformed result, nothing else.`;

  const result = await quickTask(prompt);
  return result.success ? result.content || null : null;
}

/**
 * Reset the quick model configuration
 * Call this when user settings change
 */
export function resetQuickModel(): void {
  quickAuthBlacklist.clear();
  quickModelAuthFailure = null;
  quickModelFailure = null;
  delete lastResolvedLogKeys.quick;
  delete lastResolvedLogKeys.memory;
  logger.debug('Quick model configuration reset');
}

/**
 * Check if quick model is available
 */
export function isQuickModelAvailable(): boolean {
  const config = initializeQuickModel();
  return config !== null;
}

/**
 * Get quick model info for debugging
 */
export function getQuickModelInfo(): { provider: string; model: string } | null {
  const config = getQuickModelRuntimeInfo();
  return config ? { provider: config.provider, model: config.model } : null;
}

export function getQuickModelRuntimeInfo(): { provider: string; model: string; baseUrl: string } | null {
  const config = initializeQuickModel();
  return config ? { provider: config.provider, model: config.model, baseUrl: config.baseUrl } : null;
}
