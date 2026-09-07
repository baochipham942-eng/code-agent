// ============================================================================
// Run-level tool policy（纯函数，零重依赖）
//
// Run 级工具面收窄的统一真源：CLI `--tools` / `--disallowed-tools`、web 工作台
// toolScope、agent 路由 denylist 都收敛到同一组语义：
//   - deniedToolNames：命中即禁用（大小写不敏感，支持 `skill:<name>` 原生命名）
//   - allowedToolNames：非空即"精确白名单"——名单外的工具一律视为禁用；
//     不做任何"核心工具兜底保留"，白名单就是字面全集（opt-in，调用方自负）
//   - toolScope：web 工作台已选连接器/MCP 工具是白名单的合法补充（不放宽显式 deny）
//
// 放在 tools/ 叶子模块而非 agent/runtime/toolRunPolicy.ts：ToolExecutor 也要用
// （执行层兜底闸），反向 import agent/runtime 会引入 posthog/logger 等重依赖。
// agent/runtime/toolRunPolicy.ts 的 RuntimeContext 包装层委托到本模块。
// ============================================================================

import {
  CONNECTOR_TOOL_NAMES,
  extractMcpServerIdFromToolName,
} from '../../shared/contract/workbenchTools';
import type { WorkbenchToolScope } from '../../shared/contract/conversationEnvelope';

export interface RunToolPolicy {
  readonly deniedToolNames?: readonly string[];
  readonly allowedToolNames?: readonly string[];
  readonly toolScope?: WorkbenchToolScope;
}

function normalizeRunPolicyToolName(name: string): string {
  return name.trim().toLowerCase();
}

function deniedToolSet(policy: RunToolPolicy): Set<string> | null {
  const denied = (policy.deniedToolNames ?? [])
    .map(normalizeRunPolicyToolName)
    .filter(Boolean);
  return denied.length > 0 ? new Set(denied) : null;
}

function allowedToolSet(policy: RunToolPolicy): Set<string> | null {
  const allowed = (policy.allowedToolNames ?? [])
    .map(normalizeRunPolicyToolName)
    .filter(Boolean);
  return allowed.length > 0 ? new Set(allowed) : null;
}

function isToolAllowedByWorkbenchScope(
  scope: WorkbenchToolScope | undefined,
  toolName: string,
): boolean {
  const normalized = normalizeRunPolicyToolName(toolName);
  const connectorAllowed = (scope?.allowedConnectorIds ?? []).some((connectorId) => (
    (CONNECTOR_TOOL_NAMES[connectorId] ?? []).some((name) => normalizeRunPolicyToolName(name) === normalized)
  ));
  if (connectorAllowed) return true;

  const mcpServerId = extractMcpServerIdFromToolName(toolName);
  return Boolean(mcpServerId && scope?.allowedMcpServerIds?.includes(mcpServerId));
}

/** 工具是否被 run 级策略禁用（deny 命中，或不在非空白名单内且无 toolScope 豁免）。 */
export function isToolDeniedByRunPolicy(policy: RunToolPolicy, toolName: string): boolean {
  const normalized = normalizeRunPolicyToolName(toolName);
  const allowed = allowedToolSet(policy);
  const allowedForRun = !allowed
    || allowed.has(normalized)
    || isToolAllowedByWorkbenchScope(policy.toolScope, toolName);
  return !allowedForRun || (deniedToolSet(policy)?.has(normalized) ?? false);
}

/**
 * 把一份工具名列表按 run 级策略收窄（保序去重）。
 * spawn_agent 父子交集之外的硬边界：子 agent 只能在这个面上继续收窄，永不扩张。
 */
export function narrowToolNamesByRunPolicy(
  toolNames: readonly string[],
  policy: RunToolPolicy,
): string[] {
  if (!allowedToolSet(policy) && !deniedToolSet(policy)) return [...toolNames];
  return toolNames.filter((name) => !isToolDeniedByRunPolicy(policy, name));
}

/**
 * 装配期 server 粒度预判：`mcp__<server>__*` 展开前还没有具体工具名，
 * 只在「展开后的工具确定会被本轮策略全部丢掉」时才跳过连接。
 *
 * 确定跳过：非空白名单里没有任何该 server 的 glob / 精确名，且 toolScope
 * 也没点名这个 server。拿不准（无白名单、只有 denylist、toolScope 豁免）保守连。
 */
export function couldMcpServerToolsSurviveRunPolicy(
  serverName: string,
  policy: RunToolPolicy,
): boolean {
  const globName = `mcp__${serverName}__*`;
  if (!isToolDeniedByRunPolicy(policy, globName)) return true;

  const allowed = allowedToolSet(policy);
  if (!allowed) return true;

  const prefix = `mcp__${serverName.trim().toLowerCase()}__`;
  for (const name of allowed) {
    if (name.startsWith(prefix) && name !== `${prefix}*`) return true;
  }
  return false;
}
