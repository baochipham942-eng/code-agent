import type { ToolCall } from '../../../shared/contract';
import type { MCPToolAnnotations } from '../../mcp/types';
import type { ToolSchema } from '../../protocol/tools';
import { resolveToolAlias } from '../../services/toolSearch/deferredTools';
import {
  staticAccessCoversRuntimeScope,
  type ResolvedToolAccess,
} from '../../security/resourceScope';
import type { WriteIsolationScope } from '../../security/writeIsolation';
import { resolveFoldedToolAccess } from '../../security/toolAccessResolve';
import { getProtocolRegistry } from '../protocolRegistry';
import { getProtocolToolSchemas } from '../protocolToolRegistration';
import { isBashToolName } from '../toolNames';
import { foldToolAccess } from './foldToolAccess';

const BARRIER_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'confirm_action',
  'exit_plan_mode',
  'attempt_completion',
]);

const UNKNOWN_READWRITE: ResolvedToolAccess = { kind: 'readwrite', domain: { type: 'unknown' } };

/**
 * 路径形状参数名（整词匹配，camelCase 先转 snake）。只收无歧义的词；
 * source/target/input 之类泛型名不进表，靠描述判据补。
 */
const PATH_PARAM_NAME_TOKENS = new Set([
  'path', 'paths', 'file', 'files', 'filepath', 'file_path', 'dir', 'dirs',
  'directory', 'directories', 'folder', 'folders', 'cwd', 'filename', 'file_name',
  'input_path', 'output_path', 'input_file', 'output_file', 'input_files',
  'output_files', 'outdir', 'out_dir', 'workdir', 'work_dir', 'working_dir',
  'working_directory', 'notebook_path', 'template_path', 'data_path',
]);

/** 描述里出现路径/glob 语义即按路径参数对待（宁多勿漏：漏一个就少拆一段）。 */
const PATH_PARAM_DESC_RE = /path|directory|folder|glob|目录|路径|文件夹/i;
/** 「file type」词表参数（Grep 的 type：描述里带 glob 字样但值是扩展名闭集）不是路径。 */
const FILE_TYPE_DESC_RE = /file[- ]type|文件类型/i;

const EXPRESSION_ARG_RE = /args\.([A-Za-z0-9_]+)/g;

function stringLikeProperty(prop: unknown): boolean {
  const { type, items, enum: vocabulary } = prop as {
    type?: unknown;
    items?: { type?: unknown };
    enum?: unknown;
  };
  if (vocabulary !== undefined) return false; // 闭集词表（enum）不是路径
  if (Array.isArray(type)) return type.includes('string');
  if (type === 'array') return items?.type === 'string';
  return type === 'string';
}

/**
 * schema 里"长得像路径"的参数（N-TOOLRES-K2 r3）：名字整词命中或描述含路径/glob 语义，
 * 且类型是 string / string[]。调度只能把这些参数当成工具可能真的会碰的路径——
 * 谁没被声明覆盖，谁的访问集就没被证完。
 * 行为由 tests/unit/tools/toolAccessCoverageInvariant.test.ts 经 resolver 钉死。
 */
function pathTypedPropertyNames(schema: ToolSchema): string[] {
  const properties = (schema.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const names: string[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (!stringLikeProperty(prop)) continue;
    const token = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (PATH_PARAM_NAME_TOKENS.has(token)) {
      names.push(name);
      continue;
    }
    const description = typeof (prop as { description?: unknown }).description === 'string'
      ? (prop as { description: string }).description
      : '';
    if (PATH_PARAM_DESC_RE.test(description) && !FILE_TYPE_DESC_RE.test(description)) names.push(name);
  }
  return names;
}

/** 显式 accesses（argumentNames + expression 里引用的 args.X）、pathAuthority、emission 共同覆盖的参数名。 */
function declaredPathParameterNames(schema: ToolSchema): Set<string> {
  const covered = new Set<string>();
  for (const declaration of schema.accesses ?? []) {
    for (const name of declaration.argumentNames ?? []) covered.add(name);
    if (declaration.expression) {
      for (const match of declaration.expression.matchAll(EXPRESSION_ARG_RE)) covered.add(match[1]);
    }
  }
  for (const authority of schema.pathAuthority ?? []) {
    if (authority.kind === 'path' || authority.kind === 'global-memory') covered.add(authority.pathParameter);
  }
  const emission = schema.emission;
  if (emission?.kind === 'external_file_write') covered.add(emission.targetParameter);
  if (emission?.kind === 'external_effect') {
    for (const name of emission.targetParameters) covered.add(name);
  }
  return covered;
}

/**
 * r3 不变量：路径形状参数没有被声明证完的工具，访问集按 unknown read+write 处理
 * （串行，与 pre-PR 一致）。多路径工具要并发，唯一的路是把 accesses 声明补全。
 */
function accessSetIsProvenComplete(schema: ToolSchema): boolean {
  const covered = declaredPathParameterNames(schema);
  return pathTypedPropertyNames(schema).every((name) => covered.has(name));
}

export interface ResolveToolCallAccessOptions {
  readonly workspace: string;
  readonly cwd: string;
  readonly mcpAnnotations?: Map<string, MCPToolAnnotations>;
}

function builtinSchemas(): readonly ToolSchema[] {
  const fromPort = getProtocolToolSchemas();
  if (fromPort.length > 0) return fromPort;
  try {
    const schemas = getProtocolRegistry()?.getSchemas?.() ?? [];
    return schemas.length > 0 ? schemas : fromPort;
  } catch {
    return fromPort;
  }
}

function findBuiltinSchema(schemas: readonly ToolSchema[], requested: string): ToolSchema | undefined {
  const aliased = resolveToolAlias(requested);
  return schemas.find((schema) => {
    if (schema.name === requested || schema.name === aliased) return true;
    if (schema.aliases?.some((alias) => alias === requested || alias === aliased)) return true;
    return isBashToolName(requested) && isBashToolName(schema.name);
  });
}

function orUnknown(resolved: readonly ResolvedToolAccess[]): ResolvedToolAccess[] {
  return resolved.length > 0 ? [...resolved] : [UNKNOWN_READWRITE];
}

/** 内置 schema 优先于 mcp_ 前缀。读/写只看折叠结果，不看工具名字。 */
export function resolveToolCallAccesses(
  toolCall: ToolCall,
  options: ResolveToolCallAccessOptions,
): ResolvedToolAccess[] {
  const schema = findBuiltinSchema(builtinSchemas(), toolCall.name);
  if (schema) {
    if (!accessSetIsProvenComplete(schema)) return [UNKNOWN_READWRITE];
    const folded = foldToolAccess({
      accesses: schema.accesses,
      readOnly: schema.readOnly,
      pathAuthority: schema.pathAuthority,
      emission: schema.emission,
    });
    return orUnknown(resolveFoldedToolAccess({
      toolName: schema.name,
      folded,
      params: toolCall.arguments ?? {},
      workspace: options.workspace,
      cwd: options.cwd,
    }));
  }
  if (toolCall.name.startsWith('mcp_')) {
    const folded = foldToolAccess({
      mcpTool: true,
      mcpAnnotations: options.mcpAnnotations?.get(toolCall.name),
    });
    return orUnknown(resolveFoldedToolAccess({
      toolName: toolCall.name,
      folded,
      params: toolCall.arguments ?? {},
      workspace: options.workspace,
      cwd: options.cwd,
    }));
  }
  return [UNKNOWN_READWRITE];
}

/** 屏障按规范名识别。PlanMode 只有 action 为 exit 时才是屏障。 */
export function isBarrierToolCall(toolCall: ToolCall): boolean {
  const schema = findBuiltinSchema(builtinSchemas(), toolCall.name);
  const canonical = schema?.name ?? resolveToolAlias(toolCall.name);
  if (canonical === 'PlanMode') return toolCall.arguments?.action === 'exit';
  return BARRIER_TOOL_NAMES.has(canonical);
}

export interface ResourceScopeMismatch {
  toolCallId: string | null;
  toolName: string;
  /** 静态访问域的短描述串（kind:domain），只进 trace，不含文件内容。 */
  staticDomains: string[];
  runtimeLockKey: string;
}

/** 访问域的短描述：named 域带名字，其余域只报类型。 */
function describeAccess(access: ResolvedToolAccess): string {
  const domain = access.domain;
  const domainText = domain.type === 'named' ? `named:${domain.name}` : domain.type;
  return `${access.kind}:${domainText}`;
}

/**
 * ADR-073 §3 mismatch 检查：静态声明解析出的访问域盖不住运行时写锁域时，返回
 * resource_scope_mismatch 的 trace 负载；盖得住或运行时无锁返回 null。锁本身
 * 由调用方照常获取——分歧的串行化就是锁等待，绝不因静态说"安全"跳过锁。
 * resolver 抛错按不覆盖处理（记 resolver-error），不向调用方抛。
 */
export function findResourceScopeMismatch(
  toolName: string,
  params: Record<string, unknown>,
  options: ResolveToolCallAccessOptions & { readonly toolCallId?: string },
  runtimeScope: WriteIsolationScope | null,
): ResourceScopeMismatch | null {
  if (!runtimeScope) return null;
  const toolCallId = options.toolCallId ?? null;
  let accesses: readonly ResolvedToolAccess[];
  try {
    accesses = resolveToolCallAccesses({ id: '', name: toolName, arguments: params }, options);
  } catch {
    return { toolCallId, toolName, staticDomains: ['resolver-error'], runtimeLockKey: runtimeScope.lockKey };
  }
  if (staticAccessCoversRuntimeScope(accesses, runtimeScope)) return null;
  return {
    toolCallId,
    toolName,
    staticDomains: accesses.map(describeAccess),
    runtimeLockKey: runtimeScope.lockKey,
  };
}
