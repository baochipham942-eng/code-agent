// ============================================================================
// 原生连接器意图判据 — 单一真源（N-FG-CONNECTOR-TOOLS）
// ----------------------------------------------------------------------------
// 「本轮输入命中连接器意图 × 设置里启用 × registry 就绪」→ 该连接器的读写工具名。
// 两个消费方共用，判据/正则只允许存在这一份：
//   1. agent/runtime/contextAssembly/deferredToolPreload.ts —— deferred 预载；
//   2. app/sessionCommandCenterBrain.ts —— 文字前台 per-turn allowlist 扩展
//      （ADR-059 修订：连接器工具按轮进面，不做 schema 常驻声明，防前缀缓存打掉）。
// ============================================================================

import { CONNECTOR_TOOL_NAMES } from '../../shared/contract/workbenchTools';
import { isCoreToolName } from '../services/toolSearch/deferredTools';
import { createLogger } from '../services/infra/logger';
import { getConnectorRegistry } from './registry';
import { getConfigService } from '../services/core/configService';

const logger = createLogger('ContextAssembly');

// 意图正则守则（issue #322）：\b 对 . / - 等非单词字符也成立，"notes.md" 能穿过
// \bnotes\b；裸词缺 \b 会被子串误命中（"express" 含 "press"）。误触的代价不止暴露
// 无关工具——工具表突变会整体打掉 provider 前缀缓存（PR#321 审计附录实测归因）。
// 所以：英文单词一律带 \b，高频语境词要求明确 app/动作搭配。
const NATIVE_CONNECTOR_INTENT_RES: ReadonlyArray<readonly [string, RegExp]> = [
  ['reminders', /提醒(?:事项|我)?|待办|\breminders?\b|\bto-?do\b|\bremind\s+me\b/i],
  ['mail', /邮件|邮箱|草稿|\be-?mails?\b|\bmail\b|\bdraft\b/i],
  ['calendar', /日程|日历|\bcalendar\b|\bschedule\s+(?:a|an|the)\s+(?:meeting|event)\b/i],
];

export interface NativeConnectorIntentInput {
  /** 本轮用户输入（最新一条 user 消息或前台 prompt 原文）。 */
  userText: string;
  /**
   * 用户本轮手选的连接器（web 工作台 toolScope.allowedConnectorIds）。
   * 非空 = 显式收窄：不在其中的连接器不追加。文字前台无手选时传 undefined。
   */
  allowedConnectorIds?: readonly string[];
}

/**
 * 意图 × 启用 × 就绪 → 连接器工具名（core 工具除外，它们本就常驻）。
 * 无意图命中时零副作用（不触 configService/registry），无关轮次的前缀缓存不受影响。
 * 就绪口径与 cron.ipc / cronMailPoller 一致：unchecked（重启后未探测）仍算可用，
 * failed / unavailable 才排除——已授权用户不该被逼去再点一次。
 */
export function getNativeConnectorToolNamesForIntent(input: NativeConnectorIntentInput): string[] {
  const matched = NATIVE_CONNECTOR_INTENT_RES
    .filter(([, re]) => re.test(input.userText))
    .map(([id]) => id);
  if (matched.length === 0) return [];

  let enabledNative: readonly string[] = [];
  try {
    enabledNative = getConfigService().getSettings().connectors?.enabledNative ?? [];
  } catch (error) {
    logger.warn('[ContextAssembly] Native connector preload skipped (reason: config-unavailable)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const scoped = input.allowedConnectorIds ?? [];
  const registry = getConnectorRegistry();
  const tools: string[] = [];
  for (const connectorId of matched) {
    if (!enabledNative.includes(connectorId)) {
      logger.warn(`[ContextAssembly] Native connector not preloaded (reason: not-enabled): ${connectorId}`);
      continue;
    }
    // 用户本轮手选了别的连接器 = 显式收窄，不替他加。
    if (scoped.length > 0 && !scoped.includes(connectorId)) continue;
    const connector = registry.get(connectorId);
    if (!connector) {
      logger.warn(`[ContextAssembly] Enabled native connector not preloaded (reason: not-registered): ${connectorId}`);
      continue;
    }
    const readiness = connector.getCachedStatus?.().readiness;
    if (readiness === 'failed' || readiness === 'unavailable') {
      logger.warn(`[ContextAssembly] Enabled native connector not preloaded (reason: readiness-${readiness}): ${connectorId}`);
      continue;
    }
    for (const toolName of CONNECTOR_TOOL_NAMES[connectorId] ?? []) {
      if (!isCoreToolName(toolName)) tools.push(toolName);
    }
  }
  return tools;
}
