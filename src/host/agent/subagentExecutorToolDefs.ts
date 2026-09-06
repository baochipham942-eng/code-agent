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
  isToolDeniedByRunPolicy,
  narrowToolNamesByRunPolicy,
  type RunToolPolicy,
} from '../tools/runToolPolicy';
import { isExternalSendingBlockedForRole } from '../services/roleAssets/rolePersonalization';
import { isExternalSideEffectTool } from '../tools/externalSideEffect';
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

/** 装配到的候选：请求名（声明/展开词汇，run 策略与角色边界同词汇表）与注册表定义配对。 */
interface ResolvedToolEntry {
  requestedName: string;
  def: ToolDefinition;
}

/** 解析一轮：返回装配到的候选与注册表里找不到的名字。 */
function resolveToolNamesOnce(
  allowedToolNames: readonly string[],
  resolver: SubagentToolResolverPort,
): { entries: ResolvedToolEntry[]; missing: string[] } {
  const entries: ResolvedToolEntry[] = [];
  const missing: string[] = [];
  for (const name of allowedToolNames) {
    // agent 定义里仍用 legacy snake_case 工具名（glob/grep/read_file/list_directory/
    // web_search 等），而 protocol registry 用 PascalCase 规范名。先过 resolveToolAlias
    // 归一，否则子代理的核心工具会被整组 strip 掉（"not found in registry"），导致 spawn
    // 出来的子代理无工具可用、干不成活。这是多 agent 委派"跑不通"的根因之一。
    const canonical = resolveToolAlias(name);
    const def = resolver.getDefinition(canonical) ?? resolver.getDefinition(name);
    if (def) {
      entries.push({ requestedName: name, def });
    } else {
      missing.push(name);
    }
  }
  return { entries, missing };
}

function warnMissingTools(missing: string[]): void {
  logger.warn(`filterToolDefs: ${missing.length} tools not found in registry: ${missing.join(', ')}`);
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

/** 通配展开结果：可进工具表的名字 + 策略允许但未展开成的通配（失败账）。 */
interface ExpandedSubagentMcpToolNames {
  /** 非通配声明名 + 展开成的具体 MCP 工具名（保序去重）；不含未解析的通配名。 */
  names: string[];
  /**
   * run 策略允许（server 粒度预判放行）但没拿到工具的通配（server 连不上 / 连后无匹配）。
   * 失败账不走白名单过滤：未解析的通配名不是可执行工具、绝不进工具表，但必须进
   * 缺失清单——否则「声明是通配、白名单是精确名」的形态不匹配会把装配失败滤成
   * 零工具静默成功（R4 回归）。run 策略整体排除的 server 不在此列（策略性排除 ≠ 装配失败）。
   */
  unresolvedGlobs: string[];
}

/**
 * 把声明的 `mcp__<server>__*` 通配展开成具体工具名（保序去重）。
 * server 未连接时先触发按需连接再取列表。连接前先按 run 策略做 server 粒度预判：
 * 本轮确定会被全部丢掉的 server 不连，其通配整组丢弃（策略性排除不算缺失）；
 * 预判放行但连不上 / 连后没有匹配工具的通配进 unresolvedGlobs 失败账，
 * 由 resolveSubagentToolAccess 并入缺失清单（而不是无声吞掉整组工具）。
 */
async function expandSubagentMcpToolGlobs(
  declaredToolNames: readonly string[],
  options?: SubagentToolAssemblyAbort,
): Promise<ExpandedSubagentMcpToolNames> {
  const globServers = new Map<string, string>();
  for (const name of declaredToolNames) {
    const reference = parseMcpToolReference(name);
    if (reference?.glob) globServers.set(name, reference.serverName);
  }
  if (globServers.size === 0) {
    return { names: [...declaredToolNames], unresolvedGlobs: [] };
  }

  const connectedServers = new Set<string>();
  const policyExcludedServers = new Set<string>();
  for (const serverName of new Set(globServers.values())) {
    if (options?.signal?.aborted) break;
    if (options?.runPolicy && !couldMcpServerToolsSurviveRunPolicy(serverName, options.runPolicy)) {
      policyExcludedServers.add(serverName);
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

  const names: string[] = [];
  const unresolvedGlobs: string[] = [];
  const seen = new Set<string>();
  for (const name of declaredToolNames) {
    const serverName = globServers.get(name);
    if (!serverName) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      continue;
    }
    if (policyExcludedServers.has(serverName)) continue;
    const prefix = `mcp__${serverName}__`;
    const matches = connectedServers.has(serverName)
      ? serverToolNames.filter((toolName) => toolName.startsWith(prefix))
      : [];
    if (matches.length > 0) {
      for (const candidate of matches) {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          names.push(candidate);
        }
      }
    } else {
      unresolvedGlobs.push(name);
    }
  }
  return { names, unresolvedGlobs };
}

interface SubagentToolResolution {
  entries: ResolvedToolEntry[];
  /** 声明了但（触发按需连接后仍）解析不到的工具名。 */
  missing: string[];
}

/**
 * 子代理工具装配：首轮解析后，对 MCP 形态的缺失先触发对应 server 的按需连接再
 * 解析一次，仍取不到才计入缺失。内置工具的缺失不触发任何连接，只 warn 记入缺失清单。
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

  const entries = [...first.entries];
  const missing: string[] = [];
  for (const name of first.missing) {
    const canonical = resolveToolAlias(name);
    const def = resolver.getDefinition(canonical) ?? resolver.getDefinition(name);
    if (def) {
      entries.push({ requestedName: name, def });
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    logger.warn(
      `filterToolDefs: ${missing.length} tools still not found after lazy MCP connect: ${missing.join(', ')}`,
    );
  }
  return { entries, missing };
}

export interface SubagentToolAccess {
  /** 收窄/展开后的有效工具名（run 级硬边界内，保序去重）。 */
  effectiveToolNames: string[];
  /** 注册表解析到的候选（请求名↔定义配对）。只是候选——去留由出口闸裁定。 */
  resolvedToolEntries: ResolvedToolEntry[];
  /** 声明了但（触发按需连接后仍）解析不到的工具名，含策略允许但未展开成的 MCP 通配。 */
  missingToolNames: string[];
}

/**
 * 子代理工具面装配（原 executeInternal 内联的三步，收口为可单测的纯装配）：
 *   1. 父子交集（tools 交集是核心约束，永不扩张；parent.availableTools 为空时退化为
 *      child 声明，避免无害 caller 拿不到任何工具）
 *   2. mcp__<server>__* 通配展开（只为 run 策略过滤后仍可能保留的 lazy 服务器连；
 *      展开失败的通配单独记失败账，不进工具表）
 *   3. run 级工具面硬边界收窄 + 注册表解析（MCP 形态缺失先连再取一次）
 *
 * 只产生候选与账目，不裁定「谁能进模型工具表」——那是出口闸
 * （applySubagentToolExitGate）的唯一职责。收窄留在装配期是为了：省掉注定被
 * run 策略丢弃的 MCP server 连接（R3），并让「策略性排除 ≠ 装配失败」的缺失
 * 记账成立（R4）。
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
  // 可执行工具与失败账分两条路（R4）：工具名过 run 白名单收窄（子代理只收窄）；
  // 通配装配失败信息不过白名单——否则声明 `mcp__<server>__*` 而白名单只写精确名时，
  // 形态不匹配会把「要的东西没拿到」滤掉，装配失败变成零工具静默成功。
  const effectiveToolNames = applyRunToolPolicyToSubagentTools(expanded.names, context);
  const { entries, missing } = await resolveSubagentToolDefs(effectiveToolNames, context.resolver, options);
  const missingToolNames = [...new Set([...missing, ...expanded.unresolvedGlobs])];
  return { effectiveToolNames, resolvedToolEntries: entries, missingToolNames };
}

// ----------------------------------------------------------------------------
// 出口闸（N-SUBAGENT-ZEROTOOLS R5）——最终工具表的唯一裁定点
// ----------------------------------------------------------------------------
// 教训（R3/R4/R5 三轮同形）：约束散在「展开/过滤」链的某一侧，每加一个展开/过滤
// 步骤就可能漏掉某个约束。收口方式：装配链不管经历几次展开、过滤、重解析，产物要
// 交给模型必须过这一道闸，全部约束（run 策略、角色硬边界、fail-loud 判定）在这里
// 集中应用一次。展开只负责把通配变成具体名字，不负责决定谁能留下。

/** 闸产物 brand：只在 applySubagentToolExitGate 内构造，结构上不经闸到不了模型。 */
const subagentToolSurfaceBrand = Symbol('subagentToolSurface');

/**
 * 出口闸唯一产物：最终交给模型的工具面。buildSubagentToolTable 只收这个类型——
 * 装配链里任何新展开/过滤步骤拿到的都是裸候选，要变成模型可见工具表必须过闸
 * （brand 字段在模块外无法构造），不存在旁路。
 */
export interface SubagentToolSurface {
  readonly [subagentToolSurfaceBrand]: true;
  /** 最终工具定义（全约束过滤后，模型工具表的唯一合法来源）。 */
  readonly toolDefs: readonly ToolDefinition[];
  /** 最终工具名（运行时执行白名单与它同源）。 */
  readonly toolNames: readonly string[];
  /** 失败账：声明了但解析不到 / 策略允许但未展开的通配（不随闸收窄变化）。 */
  readonly missingToolNames: readonly string[];
  /** 闸收窄留痕：被哪条约束拿掉了什么（warn 审计 + 测试）。 */
  readonly removedToolNames: readonly { tool: string; reason: 'run-policy' | 'role-boundary' }[];
  /** fail-loud 判定（R1/R4）：非 null ⇒ 装配失败，调用方必须结构化失败返回。 */
  readonly assemblyFailure: { missingTools: readonly string[] } | null;
}

/** 出口闸约束集：闸从这里取全部约束，调用方无法漏传某一条。 */
export interface SubagentToolExitGateConstraints {
  /** run 级硬边界（CLI --tools / 工作台 toolScope / 角色边界转 run 白名单）。 */
  runPolicy: RunToolPolicy;
  /** 持久化角色 id：有硬边界（如「不允许对外发送」）时对最终名单收口。 */
  roleId?: string;
  /** 装配取消信号：已取消时 fail-loud 让位 abort 收口，不误报 tool-unavailable。 */
  signal?: AbortSignal;
}

/**
 * 出口闸：装配候选 → 最终工具表。
 *
 * 集中应用的约束：
 *   - 角色硬边界（R5）：`isExternalSideEffectTool` 只认具体工具名，声明期预滤
 *     （applyRoleBoundaryToSubagentRequest）认不出 `mcp__lark__*` 通配里的发送
 *     工具——通配展开成具体名后必须在这里重判，否则边界角色仍可对外发送。
 *   - run 策略重放：装配期已收窄过（R3 连接预算 / R4 记账），这里权威重放一次，
 *     中间任何步骤放进来的漏网之名在此裁掉。
 *   - fail-loud（R1/R4）：请求集或失败账非空而最终表为空 ⇒ 装配失败。
 *
 * 策略性排除（run 策略/角色边界拿掉的名字）不是装配失败：不进失败账、不触发
 * fail-loud（与 R4「被滤掉的名字不算缺失」同一语义）。
 */
export function applySubagentToolExitGate(
  assembly: SubagentToolAccess,
  constraints: SubagentToolExitGateConstraints,
): SubagentToolSurface {
  // 角色硬边界开关（单一真源 isExternalSendingBlockedForRole）；具体名是否算
  // 「对外发送」由 isExternalSideEffectTool 裁定——两个都是闸的直接依赖
  const boundaryOn = constraints.roleId
    ? isExternalSendingBlockedForRole(constraints.roleId)
    : false;

  const kept: ResolvedToolEntry[] = [];
  const removed: Array<{ tool: string; reason: 'run-policy' | 'role-boundary' }> = [];
  const droppedRequested = new Set<string>();
  for (const entry of assembly.resolvedToolEntries) {
    if (isToolDeniedByRunPolicy(constraints.runPolicy, entry.requestedName)) {
      droppedRequested.add(entry.requestedName);
      removed.push({ tool: entry.requestedName, reason: 'run-policy' });
      continue;
    }
    // 声明名与注册表规范名两套词汇都判：通配展开出的具体名（如
    // mcp__lark__im.v1.message.create）在这里被真实分类器拦下（R5）
    if (
      boundaryOn
      && (isExternalSideEffectTool(entry.requestedName) || isExternalSideEffectTool(entry.def.name))
    ) {
      droppedRequested.add(entry.requestedName);
      removed.push({ tool: entry.def.name, reason: 'role-boundary' });
      continue;
    }
    kept.push(entry);
  }
  if (removed.length > 0) {
    logger.warn(`exitGate: ${removed.length} 个候选工具被出口闸收窄：${
      removed.map(({ tool, reason }) => `${tool}(${reason})`).join(', ')
    }`);
  }

  // 策略性排除从请求集剔除（不是装配失败）；失败账原样透传（R4：不过滤）
  const effectiveRequested = assembly.effectiveToolNames.filter((name) => !droppedRequested.has(name));
  const assemblyFailure = !constraints.signal?.aborted
    && kept.length === 0
    && (effectiveRequested.length > 0 || assembly.missingToolNames.length > 0)
    ? { missingTools: [...assembly.missingToolNames] }
    : null;

  return {
    [subagentToolSurfaceBrand]: true,
    toolDefs: kept.map((entry) => entry.def),
    toolNames: kept.map((entry) => entry.def.name),
    missingToolNames: [...assembly.missingToolNames],
    removedToolNames: removed,
    assemblyFailure,
  };
}

/** 模型工具表条目：发给推理层的 ToolDefinition 投影（与 inference 侧入参同形）。 */
export type SubagentToolTableEntry = Pick<
  ToolDefinition,
  'name' | 'description' | 'inputSchema' | 'outputSchema' | 'requiresPermission' | 'permissionLevel'
>;

/**
 * 模型工具表投影：模型不支持工具调用（registry supportsTool=false）时给空表并 warn，
 * 支持时把闸后定义映射成 inference 入参。是否支持未知（模型不在 registry）按支持处理。
 * 只收出口闸产物（SubagentToolSurface）——装配链的裸候选在类型上进不了模型工具表。
 */
export function buildSubagentToolTable(
  agentName: string,
  modelConfig: Pick<ModelConfig, 'provider' | 'model'>,
  surface: SubagentToolSurface,
): { toolDefinitions: SubagentToolTableEntry[]; supportsTool: boolean } {
  const providerConfig = PROVIDER_REGISTRY[modelConfig.provider];
  const modelInfo = providerConfig?.models.find(
    (m: { id: string; supportsTool?: boolean }) => m.id === modelConfig.model,
  );
  const supportsTool = modelInfo?.supportsTool ?? true; // Default to true if unknown
  if (!supportsTool) {
    if (surface.toolDefs.length > 0) {
      logger.warn(`[${agentName}] Model ${modelConfig.model} does not support tool calls, tools will be ignored`);
    }
    return { toolDefinitions: [], supportsTool };
  }
  return {
    toolDefinitions: surface.toolDefs.map((tool) => ({
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
