// ============================================================================
// 统一 ID 生成器
// ============================================================================

import { v4 as uuidv4 } from 'uuid';

/**
 * 生成全局唯一的消息 ID
 * 格式: UUID v4 (例: "550e8400-e29b-41d4-a716-446655440000")
 */
export function generateMessageId(): string {
  return uuidv4();
}

/**
 * 生成全局唯一的工具调用 ID
 * 格式: "tool-" + UUID v4
 * 用于文本解析回退时，保证与模型生成的 ID 格式区分
 */
export function generateToolCallId(): string {
  return `tool-${uuidv4()}`;
}

/**
 * 验证是否为有效的 ID 格式
 * 支持: UUID v4, OpenAI (call_xxx), Claude (toolu_xxx), tool-xxx
 */
export function isValidId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return (
    uuidRegex.test(id) ||
    id.startsWith('tool-') ||
    id.startsWith('call_') ||
    id.startsWith('toolu_')
  );
}

/**
 * ID 来源类型
 */
export type IdSource = 'uuid' | 'openai' | 'claude' | 'tool' | 'legacy' | 'unknown';

/**
 * 检测 ID 来源
 */
export function getIdSource(id: string): IdSource {
  if (!id || typeof id !== 'string') return 'unknown';

  // UUID v4 格式
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return 'uuid';
  }

  // 本地生成的工具调用 ID
  if (id.startsWith('tool-')) {
    return 'tool';
  }

  // OpenAI 格式
  if (id.startsWith('call_')) {
    return 'openai';
  }

  // Claude 格式
  if (id.startsWith('toolu_')) {
    return 'claude';
  }

  // 旧的时间戳格式
  if (/^\d+$/.test(id) || /^\d+-[a-z0-9]+$/i.test(id)) {
    return 'legacy';
  }

  return 'unknown';
}

/**
 * 标准化 ID（将旧格式转换为 UUID）
 * 用于数据库迁移
 */
export function normalizeId(id: string): string {
  const source = getIdSource(id);

  // 已经是有效格式，保持不变
  if (source === 'uuid' || source === 'openai' || source === 'claude' || source === 'tool') {
    return id;
  }

  // 为旧格式生成新的 UUID，保留原 ID 作为追踪信息
  // 格式: migrated-<原ID前8位>-<新UUID前8位>
  const originalPart = id.slice(0, 8);
  const newPart = uuidv4().slice(0, 8);
  return `migrated-${originalPart}-${newPart}`;
}

/**
 * 生成会话 ID
 */
export function generateSessionId(): string {
  return uuidv4();
}

/**
 * 生成权限请求 ID
 */
export function generatePermissionRequestId(): string {
  return `perm-${uuidv4()}`;
}
