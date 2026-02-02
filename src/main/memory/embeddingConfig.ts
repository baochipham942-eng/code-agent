// ============================================================================
// Embedding Configuration - 向量维度配置常量
// 统一管理不同 provider 的 embedding 维度
// ============================================================================

/**
 * 各 embedding provider 的标准维度
 */
export const EMBEDDING_DIMENSIONS = {
  deepseek: 1024,
  openai: 1536,      // text-embedding-3-small
  'openai-large': 3072, // text-embedding-3-large
  gemini: 768,       // text-embedding-004
  local: 1024,       // 统一为 1024，与 deepseek 对齐
} as const;

/**
 * 默认维度（与主要 provider DeepSeek 对齐）
 */
export const DEFAULT_EMBEDDING_DIMENSION = EMBEDDING_DIMENSIONS.deepseek;

/**
 * Supabase pgvector 存储的维度
 */
export const CLOUD_EMBEDDING_DIMENSION = 1024;

/**
 * 最小有效文本长度（用于空查询检测）
 */
export const MIN_TEXT_LENGTH = 1;

/**
 * embedding 维度类型
 */
export type EmbeddingProvider = keyof typeof EMBEDDING_DIMENSIONS;

/**
 * 根据 provider 获取维度
 */
export function getDimensionForProvider(provider: EmbeddingProvider): number {
  return EMBEDDING_DIMENSIONS[provider] || DEFAULT_EMBEDDING_DIMENSION;
}

/**
 * 验证向量维度是否匹配
 */
export function validateDimension(
  embedding: number[],
  expectedDimension: number
): { valid: boolean; actual: number; expected: number } {
  return {
    valid: embedding.length === expectedDimension,
    actual: embedding.length,
    expected: expectedDimension,
  };
}

/**
 * 标准化向量维度（截断或填充）
 * 注意：这是 fallback 方案，正常情况应使用匹配的 provider
 */
export function normalizeEmbeddingDimension(
  embedding: number[],
  targetDimension: number
): number[] {
  if (embedding.length === targetDimension) {
    return embedding;
  }

  if (embedding.length > targetDimension) {
    // 截断
    return embedding.slice(0, targetDimension);
  }

  // 填充 0
  const padded = [...embedding];
  while (padded.length < targetDimension) {
    padded.push(0);
  }
  return padded;
}

/**
 * 验证文本是否可以进行 embedding
 */
export function validateTextForEmbedding(text: string): {
  valid: boolean;
  reason?: string;
} {
  if (text === undefined || text === null) {
    return { valid: false, reason: 'Text is null or undefined' };
  }

  if (typeof text !== 'string') {
    return { valid: false, reason: 'Text must be a string' };
  }

  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) {
    return { valid: false, reason: 'Text is empty or too short' };
  }

  return { valid: true };
}
