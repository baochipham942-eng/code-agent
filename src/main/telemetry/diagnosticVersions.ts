// ============================================================================
// Diagnostic Versions — telemetry 版本指纹
// ============================================================================
// 给每条 trace/session 打三个版本字段，把"打补丁"升级为"按版本归因"：
//   - agentVersion:     构建版本（= app version），知道用户跑的哪个包
//   - promptVersion:    系统提示词粗粒度版本（PROMPT_VERSION 常量）
//   - toolSchemaVersion: 当前注册工具集 schema 的内容短 hash（自动、确定性）
//
// 精确复现仍依赖 turn 级 systemPromptHash（system_prompt_cache 存全文），
// 这里三个字段只解决"哪个版本"的归因问题。
// ============================================================================

import { createHash } from 'crypto';
import { getAppVersion } from '../platform/appPaths';
import { PROMPT_VERSION } from '../../shared/constants';
import { getProtocolRegistry } from '../tools/protocolRegistry';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('DiagnosticVersions');

/** 构建/Agent 版本 —— 复用 app version。 */
export function getAgentVersion(): string {
  return getAppVersion();
}

/** 系统提示词粗粒度版本标签。 */
export function getPromptVersion(): string {
  return PROMPT_VERSION;
}

let cachedToolSchemaVersion: string | null = null;

/**
 * 工具集 schema 版本 = 排序后 schema 关键字段的 SHA-256 前 12 位。
 * 只取 name/description/inputSchema/category 等静态字段（排除 dynamicDescription
 * 等运行时函数），保证同一份工具集每次算出同样的 hash。进程内 memoize。
 */
export function getToolSchemaVersion(): string {
  if (cachedToolSchemaVersion) return cachedToolSchemaVersion;
  try {
    const schemas = getProtocolRegistry().getSchemas();
    const normalized = schemas
      .map((s) => ({
        name: s.name,
        description: s.description,
        inputSchema: s.inputSchema,
        category: s.category,
        permissionLevel: s.permissionLevel,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    cachedToolSchemaVersion = `tools-${hash.slice(0, 12)}`;
  } catch (error) {
    logger.warn('Failed to compute tool schema version:', error);
    cachedToolSchemaVersion = 'tools-unknown';
  }
  return cachedToolSchemaVersion;
}

/** 测试用：清掉 memoize。 */
export function resetToolSchemaVersionCache(): void {
  cachedToolSchemaVersion = null;
}

/** 一次性拿全三个版本字段。 */
export function getDiagnosticVersions(): {
  agentVersion: string;
  promptVersion: string;
  toolSchemaVersion: string;
} {
  return {
    agentVersion: getAgentVersion(),
    promptVersion: getPromptVersion(),
    toolSchemaVersion: getToolSchemaVersion(),
  };
}
