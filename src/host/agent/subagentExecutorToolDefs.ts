// ============================================================================
// Subagent Executor Tool Definitions Helper
// ============================================================================
// 从 SubagentExecutor 抽出的纯工具定义过滤逻辑（不依赖实例状态）。

import type { ModelConfig, ToolDefinition } from '../../shared/contract';
import type {
  SubagentConfig,
  SubagentExecutionContext,
  SubagentToolResolverPort,
} from './subagentExecutorTypes';
import { resolveToolAlias } from '../services/toolSearch/deferredTools';
import {
  couldMcpServerToolsSurviveRunPolicy,
  narrowToolNamesByRunPolicy,
  type RunToolPolicy,
} from '../tools/runToolPolicy';
import { createLogger } from '../services/infra/logger';
import { PROVIDER_REGISTRY } from '../model/modelRouter';

const logger = createLogger('SubagentExecutor');

/** 工具面收口需要的 execution context 键（见 resolveSubagentToolAccess）。 */
type SubagentToolAccessContextKeys =
  | 'allowedToolNames'
  | 'deniedToolNames'
  | 'toolScope'
  | 'resolver';

/**
 * Run 级工具面（CLI --tools/--disallowed-tools 及等价宿主收窄）是硬边界：
 * 在父子交集结果上再收一次，穿透 parentContext 缺省/退化分支——交集为空也
 * 不许回扩到父 run 面之外（子代理只能收窄，永不扩张）。
 */
function applyRunToolPolicyToSubagentTools(
  effectiveToolNames: string[],
  context: Pick<SubagentExecutionContext, 'allowedToolNames' | 'deniedToolNames' | 'toolScope'>,
): string[] {
  return narrowToolNamesByRunPolicy(effectiveToolNames, {
    allowedToolNames: context.allowedToolNames,
    deniedToolNames: context.deniedToolNames,
    toolScope: context.toolScope,
  });
}

/** 解析一轮：返回装配到的定义与注册表里找不到的名字。 */
function resolveToolNamesOnce(
  allowedToolNames: readonly string[],
  resolver: SubagentToolResolverPort,
): { defs: ToolDefinition[]; missing: string[] } {
  const defs: ToolDefinition[] = [];
  const missing: string[] = [];
  for (const name of allowedToolNames) {
    // agent 定义里仍用 legacy snake_case 工具名（glob/grep/read_file/list_directory/
    // web_search 等），而 protocol registry 用 PascalCase 规范名。先过 resolveToolAlias
    // 归一，否则子代理的核心工具会被整组 strip 掉（"not found in registry"），导致 spawn
    // 出来的子代理无工具可用、干不成活。这是多 agent 委派"跑不通"的根因之一。
    const canonical = resolveToolAlias(name);
    const def = resolver.getDefinition(canonical) ?? resolver.getDefinition(name);
    if (def) {
      defs.push(def);
    } else {
      missing.push(name);
    }
  }
  return { defs, missing };
}

function warnMissingTools(missing: string[]): void {
  logger.warn(`filterToolDefs: ${missing.length} tools not found in registry: ${missing.join(', ')}`);
}

export function filterSubagentToolDefs(
  allowedToolNames: string[],
  resolver: SubagentToolResolverPort,
): ToolDefinition[] {
  const { defs, missing } = resolveToolNamesOnce(allowedToolNames, resolver);
  if (missing.length > 0) {
    warnMissingTools(missing);
  }
  return defs;
}

// ----------------------------------------------------------------------------
// MCP 工具装配补取（N-SUBAGENT-ZEROTOOLS）
// ----------------------------------------------------------------------------
// lazy MCP 服务器（stdio 默认 lazyLoad，如 cua-driver）没连接时注册表里查不到它的
// 工具。声明的工具解析不到时不能直接判缺失——先触发按需连接再取一次；连完仍取不到
// 才算真缺失。连接复用 MCPClient.ensureConnected（与 callTool 懒加载同一条路径），
// 不新造连接通道。

/** `mcp__<server>__*` 通配（allow 侧语义：该 server 的全部工具）。 */
const MCP_TOOL_GLOB_RE = /^mcp__(.+?)__\*$/;
/** `mcp__<server>__<tool>` 精确名（server 段取第一个 `__` 之前，与 registry.parseMCPToolName 同语义）。 */
const MCP_TOOL_NAME_RE = /^mcp__(.+?)__(.+)$/;

interface McpToolReference {
  serverName: string;
  glob: boolean;
}

function parseMcpToolReference(name: string): McpToolReference | undefined {
  const globMatch = name.match(MCP_TOOL_GLOB_RE);
  if (globMatch) return { serverName: globMatch[1], glob: true };
  const exactMatch = name.match(MCP_TOOL_NAME_RE);
  if (exactMatch) return { serverName: exactMatch[1], glob: false };
  return undefined;
}

/** 触发 lazy MCP 服务器按需连接；任何异常都按「没连上」处理，不让装配链崩掉。
 * signal 触发时立即按未连上返回（底层共享连接继续建立，见 MCPClient.ensureConnected）。 */
async function ensureMcpServerConnected(serverName: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const { getMCPClient } = await import('../mcp');
    return await getMCPClient().ensureConnected(serverName, signal);
  } catch (error) {
    logger.warn(`ensureMcpServerConnected: on-demand connect failed for ${serverName}`, error);
    return false;
  }
}

/** 装配链取消信号：两个连接循环每次连接前检查并透传给 ensureConnected（中断的是
 * 本次等待，共享连接不受影响），取消后不再发起后续服务器连接。
 * runPolicy 在通配展开前按 server 粒度丢掉确定会被挡掉的连接。 */
export interface SubagentToolAssemblyAbort {
  signal?: AbortSignal;
  runPolicy?: RunToolPolicy;
}

/**
 * 把声明的 `mcp__<server>__*` 通配展开成具体工具名（保序去重）。
 * server 未连接时先触发按需连接再取列表；连不上或连后没有匹配工具的通配原样保留，
 * 让后续解析把它记进缺失清单（而不是无声吞掉整组工具）。
 * 连接前先按 run 策略做 server 粒度预判：本轮确定会被全部丢掉的 server 不连。
 */
async function expandSubagentMcpToolGlobs(
  declaredToolNames: readonly string[],
  options?: SubagentToolAssemblyAbort,
): Promise<string[]> {
  const globServers = new Map<string, string>();
  for (const name of declaredToolNames) {
    const reference = parseMcpToolReference(name);
    if (reference?.glob) globServers.set(name, reference.serverName);
  }
  if (globServers.size === 0) return [...declaredToolNames];

  const connectedServers = new Set<string>();
  for (const serverName of new Set(globServers.values())) {
    if (options?.signal?.aborted) break;
    if (options?.runPolicy && !couldMcpServerToolsSurviveRunPolicy(serverName, options.runPolicy)) {
      continue;
    }
    if (await ensureMcpServerConnected(serverName, options?.signal)) {
      connectedServers.add(serverName);
    }
  }

  let serverToolNames: string[] = [];
  try {
    const { getMCPClient } = await import('../mcp');
    serverToolNames = getMCPClient().getToolDefinitions().map((definition) => definition.name);
  } catch (error) {
    logger.warn('expandSubagentMcpToolGlobs: failed to list MCP tool definitions', error);
  }

  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const name of declaredToolNames) {
    const serverName = globServers.get(name);
    const prefix = serverName ? `mcp__${serverName}__` : '';
    const matches = serverName && connectedServers.has(serverName)
      ? serverToolNames.filter((toolName) => toolName.startsWith(prefix))
      : [];
    for (const candidate of matches.length > 0 ? matches : [name]) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        expanded.push(candidate);
      }
    }
  }
  return expanded;
}

interface SubagentToolResolution {
  defs: ToolDefinition[];
  /** 声明了但（触发按需连接后仍）解析不到的工具名。 */
  missing: string[];
}

/**
 * 子代理工具装配（filterSubagentToolDefs 的完整形态）：
 * 首轮解析后，对 MCP 形态的缺失先触发对应 server 的按需连接再解析一次，仍取不到才
 * 计入缺失。内置工具的缺失不触发任何连接，warn 行为与 filterSubagentToolDefs 一致。
 */
async function resolveSubagentToolDefs(
  allowedToolNames: readonly string[],
  resolver: SubagentToolResolverPort,
  options?: SubagentToolAssemblyAbort,
): Promise<SubagentToolResolution> {
  const first = resolveToolNamesOnce(allowedToolNames, resolver);
  if (first.missing.length === 0) return first;

  const retryServers = new Set<string>();
  for (const name of first.missing) {
    const reference = parseMcpToolReference(name);
    if (reference && !reference.glob) retryServers.add(reference.serverName);
  }
  if (retryServers.size === 0) {
    warnMissingTools(first.missing);
    return first;
  }

  for (const serverName of retryServers) {
    if (options?.signal?.aborted) break;
    await ensureMcpServerConnected(serverName, options?.signal);
  }

  const defs = [...first.defs];
  const missing: string[] = [];
  for (const name of first.missing) {
    const canonical = resolveToolAlias(name);
    const def = resolver.getDefinition(canonical) ?? resolver.getDefinition(name);
    if (def) {
      defs.push(def);
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    logger.warn(
      `filterToolDefs: ${missing.length} tools still not found after lazy MCP connect: ${missing.join(', ')}`,
    );
  }
  return { defs, missing };
}

export interface SubagentToolAccess {
  /** 收窄/展开后的有效工具名（run 级硬边界内，保序去重）。 */
  effectiveToolNames: string[];
  /** 注册表解析到的工具定义（给模型的工具表）。 */
  allowedToolDefs: ToolDefinition[];
  /** 声明了但（触发按需连接后仍）解析不到的工具名。 */
  missingToolNames: string[];
}

/**
 * 子代理工具面收口（原 executeInternal 内联的三步，收口为可单测的纯装配）：
 *   1. 父子交集（tools 交集是核心约束，永不扩张；parent.availableTools 为空时退化为
 *      child 声明，避免无害 caller 拿不到任何工具）
 *   2. mcp__<server>__* 通配展开（只为 run 策略过滤后仍可能保留的 lazy 服务器连）
 *   3. run 级工具面硬边界收窄 + 注册表解析（MCP 形态缺失先连再取一次）
 */
export async function resolveSubagentToolAccess(
  config: Pick<SubagentConfig, 'availableTools'>,
  context: Pick<SubagentExecutionContext, SubagentToolAccessContextKeys>,
  effectiveParentContext: { availableTools: readonly string[] },
  childCtx: { toolPool: readonly string[] },
  options?: SubagentToolAssemblyAbort,
): Promise<SubagentToolAccess> {
  const pooled = effectiveParentContext.availableTools.length === 0
    ? [...config.availableTools]
    : [...childCtx.toolPool];
  const expanded = await expandSubagentMcpToolGlobs(pooled, {
    ...options,
    runPolicy: {
      allowedToolNames: context.allowedToolNames,
      deniedToolNames: context.deniedToolNames,
      toolScope: context.toolScope,
    },
  });
  const effectiveToolNames = applyRunToolPolicyToSubagentTools(expanded, context);
  const { defs, missing } = await resolveSubagentToolDefs(effectiveToolNames, context.resolver, options);
  return { effectiveToolNames, allowedToolDefs: defs, missingToolNames: missing };
}

/** 模型工具表条目：发给推理层的 ToolDefinition 投影（与 inference 侧入参同形）。 */
export type SubagentToolTableEntry = Pick<
  ToolDefinition,
  'name' | 'description' | 'inputSchema' | 'outputSchema' | 'requiresPermission' | 'permissionLevel'
>;

/**
 * 模型工具表投影：模型不支持工具调用（registry supportsTool=false）时给空表并 warn，
 * 支持时把装配到的定义映射成 inference 入参。是否支持未知（模型不在 registry）按支持处理。
 */
export function buildSubagentToolTable(
  agentName: string,
  modelConfig: Pick<ModelConfig, 'provider' | 'model'>,
  allowedToolDefs: readonly ToolDefinition[],
): { toolDefinitions: SubagentToolTableEntry[]; supportsTool: boolean } {
  const providerConfig = PROVIDER_REGISTRY[modelConfig.provider];
  const modelInfo = providerConfig?.models.find(
    (m: { id: string; supportsTool?: boolean }) => m.id === modelConfig.model,
  );
  const supportsTool = modelInfo?.supportsTool ?? true; // Default to true if unknown
  if (!supportsTool) {
    if (allowedToolDefs.length > 0) {
      logger.warn(`[${agentName}] Model ${modelConfig.model} does not support tool calls, tools will be ignored`);
    }
    return { toolDefinitions: [], supportsTool };
  }
  return {
    toolDefinitions: allowedToolDefs.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    })),
    supportsTool,
  };
}
