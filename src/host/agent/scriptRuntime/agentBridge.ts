// ============================================================================
// agentBridge —— scriptRuntime 的 agent() 原语落地（主线程侧）
//
// 这是 dynamic-workflow 「中间结果不进主 context」的关键落点：直连 SubagentExecutor.execute
// / inferenceViaAiSdk，【绕开】spawn_agent / workflowOrchestrate / parallelAgentCoordinator /
// coworkOrchestrator —— 那四条高层入口都会把会话历史/前置 stage 输出灌回 prompt（艾克斯审计）。
// execute() 自身不注入历史，喂干净 systemPrompt+prompt 即天然隔离。
//
// 两条路径：
//   - 有 schema：单轮 forced tool_choice，强制模型调一次 structured_output 工具，取其 arguments
//     作为校验过的结构化结果（命令式控制流 if/while 的稳定判断值）。不走 agent loop，最轻。
//   - 无 schema：完整 agent loop（execute），可用工具干活，返回文本。
//
// agentBridge 不直接依赖 ToolResolver/ConfigService：per-call 模型解析与 SubagentContext 派生
// 由命令层经 ScriptRunContext 注入工厂，保持运行时与宿主解耦。
// ============================================================================

import { createHash } from 'node:crypto';
import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../../model/types';
import { inferenceViaAiSdk } from '../../model/adapters/aiSdkAdapter';
import { SubagentExecutor } from '../subagentExecutor';
import type { SubagentContext } from '../subagentExecutorTypes';
import { SCRIPT_RUNTIME } from '../../../shared/constants';
import type { ConcurrencyGate } from './concurrencyGate';
import type { BudgetTracker } from './budget';
import { validateForcedSchema } from './scriptValidator';
import type { AgentCallPayload, JsonSchema, PrimitiveResult, ScriptRunCallRecord, ScriptRunEvent } from './types';
import type { WriteGate } from './writeGate';
import {
  capabilityManifestForToolProfile,
  type CapabilityManifest,
} from './capabilityManifest';
import type { ToolProfile } from './toolProfiles';
import type { AgentWorkspaceHandoff, AgentWorkspaceLease } from './types';
import { redactSecrets } from '../../security/secretRedaction';

const STRUCTURED_OUTPUT_TOOL = 'structured_output';

// 进度树用的预览截断长度——只为 GUI 显示「子 agent 在做什么/产出了什么」，不灌整段（事件要轻）。
const PROMPT_PREVIEW_CHARS = 160;
const RESULT_PREVIEW_CHARS = 200;

/** 把任意原语结果压成短预览：字符串直接截断，对象 JSON 序列化后截断。 */
function previewResult(result: PrimitiveResult): string {
  const text = typeof result === 'string' ? result : safeStringify(result);
  return truncate(redactSecrets(text), RESULT_PREVIEW_CHARS);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const DEFAULT_AGENT_SYSTEM_PROMPT =
  '你是 dynamic-workflow 编排脚本派发的子 agent。专注完成下面这一个明确子任务，' +
  '用给定工具收集信息或执行操作，最后给出简洁、可被脚本直接消费的结果。' +
  '不要寒暄，不要复述任务，不要输出与结果无关的过程描述。';

/**
 * 稳定序列化（键名递归排序）——让内容 hash 不受对象键序影响。
 * 带 seen 集合做【路径式】环检测（Codex round1 MED#2）：模型脚本可经 structured-clone 传入循环
 * schema，无保护会在主线程哈希阶段无限递归爆栈。命中环回 "[Circular]"；处理后从 seen 移除，使
 * DAG（同一子对象多处共享、非环）仍各自展开、hash 稳定。
 */
function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (seen.has(value as object)) return '"[Circular]"';
  seen.add(value as object);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${value.map((v) => stableStringify(v, seen)).join(',')}]`;
  } else {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`).join(',')}}`;
  }
  seen.delete(value as object);
  return out;
}

/**
 * 一次 agent() 调用的内容 hash（resumable 缓存键的内容部分）。
 * 哈希【决定结果】的语义输入：prompt + schema + 显式 model override + agentType + tools +
 * 【resolved provider/model】+ run 级 goal/args 上下文。纳入 resolved 模型是 Codex round1 HIGH#1
 * 修复——否则 options.model 缺省时换主模型会误命中旧结果。故意排除 label / phase（只影响显示，
 * 改它们不该让缓存失效）。
 * 仍不快照外部世界（文件/网页/工具结果）——resumable 固有语义（同 Claude Code Workflow）：
 * resume = 跳过已完成的活、假定环境未变，由调用方负责。
 */
function computeCallHash(
  call: AgentCallPayload,
  resolvedProvider: string,
  resolvedModel: string,
  runInputHash: string,
): string {
  const o = call.options ?? {};
  const semantic = {
    schema: o.schema, model: o.model, agentType: o.agentType, tools: o.tools,
    _provider: resolvedProvider, _model: resolvedModel, _runInputHash: runInputHash,
  };
  return createHash('sha256').update(`${call.prompt}\u0000${stableStringify(semantic)}`).digest('hex').slice(0, 16);
}

// 单例执行器：execute 是无状态 per-call（上下文全由参数传入），全 run 复用一个实例即可。
const executor = new SubagentExecutor();

/**
 * 一次 dynamic-workflow run 的主线程运行期上下文（非序列化，不进 worker）。
 * 由 runService 构造：注入并发闸、事件回调、以及与宿主解耦的两个工厂。
 */
export interface ScriptRunContext {
  runId: string;
  /** run 级 goal/args 上下文 hash，纳入每次 agent() 的 resumable 缓存键。 */
  runInputHash: string;
  baseModelConfig: ModelConfig;
  /** 解析 per-call model override → 完整 ModelConfig（含 apiKey/baseUrl）。命令层持有 configService/settings。 */
  resolveModelConfig: (override?: { provider: string; model: string }) => ModelConfig;
  /** 为一次 full-agent 调用派生隔离的干净 SubagentContext（不灌历史）。命令层持有 toolResolver/toolContext。 */
  deriveSubagentContext: (args: {
    agentId: string;
    modelConfig: ModelConfig;
    signal: AbortSignal;
    capabilities: Readonly<CapabilityManifest>;
    workspace?: AgentWorkspaceLease;
  }) => SubagentContext;
  /** 把 agent({tools}) 的档名解析成工具白名单 + 是否写能力（命令层注入分档策略）。 */
  resolveAgentTools: (profile?: string) => { tools: string[]; writeCapable: boolean };
  /** write-capable agent 的强制 worktree provisioner；缺失时 fail-closed。 */
  prepareAgentWorkspace?: (input: {
    agentId: string;
    capabilities: Readonly<CapabilityManifest>;
    signal: AbortSignal;
  }) => Promise<AgentWorkspaceLease>;
  /** completed 产出 handoff；cancel 必须 discard 临时 worktree。 */
  finishAgentWorkspace?: (input: {
    agentId: string;
    workspace: AgentWorkspaceLease;
    outcome: 'completed' | 'failed' | 'cancelled';
  }) => Promise<Omit<AgentWorkspaceHandoff, 'agentId'>>;
  handoffs: AgentWorkspaceHandoff[];
  /** writer 并发观测兼容字段；实际隔离由 per-agent worktree 提供。 */
  writeGuard: { inFlight: number; warned: boolean };
  /** 旧路径兼容端口；process sandbox 默认 writer path 不再使用。 */
  writeGate: WriteGate;
  /** run 级取消信号。 */
  signal: AbortSignal;
  /** provider-aware 全局并发闸。 */
  gate: ConcurrencyGate;
  /** 进度/可观测事件回调（scriptRuntime 自有事件流）。 */
  emit: (event: ScriptRunEvent) => void;
  /** 跨 run 共享的 agent() 调用计数（失控脚本兜底）。 */
  callCounter: { count: number };
  /** resumable 命中缓存的次数（供 meta 观测 resume 是否生效）。 */
  cacheHitCounter: { count: number };
  /** token 预算账本（主线程权威：每次 agent() 完成累加 outputTokens，发起前查上限）。 */
  budget: BudgetTracker;
  /** 主线程计时（worker 内禁 Date.now；bridge 在主线程可用）。 */
  now: () => number;
  /**
   * resumable 重放缓存：被 resume 的旧 run 的逐调用结果，按 callIndex 索引。
   * 命中（同 index 且 contentHash 一致）→ 瞬时返回、不 inference、不耗 budget。缺省 = 不重放（全 live）。
   */
  resumeCalls?: Map<number, { contentHash: string; result: PrimitiveResult }>;
  /** 把一次成功调用（命中或 live）写进【本 run】journal，供后续链式 resume。缺省 = 不持久化。 */
  recordCall?: (record: ScriptRunCallRecord) => void;
}

/** 执行模型脚本里的一次 agent() 调用。worker 经 RPC 把调用 marshal 到主线程后落到这里。 */
export async function runAgentCall(call: AgentCallPayload, ctx: ScriptRunContext): Promise<PrimitiveResult> {
  if (ctx.callCounter.count >= SCRIPT_RUNTIME.MAX_AGENT_CALLS_PER_RUN) {
    throw new Error(`agent() 调用数超过单 run 上限 ${SCRIPT_RUNTIME.MAX_AGENT_CALLS_PER_RUN}`);
  }
  // callCounter 自增必须在第一个 await 之前（单线程同步），保证 callIndex = 声明序、跨 run 重放对齐。
  ctx.callCounter.count++;
  const callIndex = ctx.callCounter.count;

  const modelConfig = ctx.resolveModelConfig(call.options?.model);
  const provider = modelConfig.provider;
  const label = call.options?.label ?? call.options?.phase ?? 'agent';
  const agentId = `${ctx.runId}-a${callIndex}`;
  const contentHash = computeCallHash(call, provider, modelConfig.model, ctx.runInputHash);

  // ── resumable 缓存命中：同 callIndex 且 contentHash 一致 → 瞬时返回，不 inference / 不占 gate /
  //    不耗 budget（成本已在原 run 付过）。复制进本 run journal 使其自包含，支持链式 resume（0 token）。 ──
  const cached = ctx.resumeCalls?.get(callIndex);
  if (cached?.contentHash === contentHash) {
    ctx.cacheHitCounter.count++;
    ctx.emit({
      runId: ctx.runId,
      type: 'agent:start',
      ts: ctx.now(),
      data: {
        agentId, label, provider, model: modelConfig.model,
        hasSchema: !!call.options?.schema, phase: call.options?.phase,
        promptPreview: truncate(redactSecrets(call.prompt), PROMPT_PREVIEW_CHARS),
        cached: true,
      },
    });
    ctx.emit({
      runId: ctx.runId,
      type: 'agent:done',
      ts: ctx.now(),
      data: { agentId, label, resultPreview: previewResult(cached.result), cached: true },
    });
    ctx.recordCall?.({ callIndex, contentHash, result: cached.result, tokensUsed: 0, label, ts: ctx.now() });
    return cached.result;
  }

  // 预算硬上限（对齐 Claude Code Workflow）：耗尽后再发起的【live】agent() 直接抛，让脚本能用
  // while(budget.remaining()>x) 动态收敛。命中缓存不受此限（上面已 return）。enforce 在主线程、是权威。
  if (ctx.budget.exceeded()) {
    throw new Error(`token budget 已耗尽（${ctx.budget.spent()}/${ctx.budget.total}）`);
  }

  const release = await ctx.gate.acquire(provider, ctx.signal);
  ctx.emit({
    runId: ctx.runId,
    type: 'agent:start',
    ts: ctx.now(),
    data: {
      agentId,
      label,
      provider,
      model: modelConfig.model,
      hasSchema: !!call.options?.schema,
      // 进度树分组 + 显示「这个子 agent 在做什么」。phase 归属用 options.phase（脚本声明的所属阶段）。
      phase: call.options?.phase,
      promptPreview: truncate(redactSecrets(call.prompt), PROMPT_PREVIEW_CHARS),
    },
  });

  // 并发预留 + 权威复检：reserveOrThrow 必须在 gate.acquire 之后、与 reserve 无 await 间隔，
  // 消除「顶部 fail-fast → await gate → 醒来」期间被并发推满预算的 TOCTOU（Codex R2 HIGH#1）。
  // 放进 try：耗尽抛出时也走 finally 释放 gate 槽；reservedDone 防未预留却误 commit。
  let reserved = 0;
  let reservedDone = false;
  // 真实 outputTokens 在两条路径里求出，无论成功/失败/抛错都在 finally 统一 commit（Codex HIGH#2 漏计）。
  let actualTokens = 0;
  try {
    reserved = ctx.budget.reserveOrThrow();
    reservedDone = true;
    let result: PrimitiveResult;
    if (call.options?.schema) {
      const forced = await runForcedStructured(call.prompt, call.options.schema, modelConfig, ctx.signal);
      actualTokens = forced.outputTokens; // 即便没拿到 tool call 也已消耗，先记账
      if (forced.missingToolCall) {
        throw new Error('forced structured output：模型未返回 tool call');
      }
      result = forced.value as PrimitiveResult;
    } else {
      const { tools, writeCapable } = ctx.resolveAgentTools(call.options?.tools);
      const profile = (call.options?.tools ?? 'readonly') as ToolProfile;
      const capabilities = capabilityManifestForToolProfile(profile);
      if (writeCapable && (!ctx.prepareAgentWorkspace || !ctx.finishAgentWorkspace)) {
        throw new Error('write-capable workflow agent requires an isolated worktree provider');
      }
      const workspace = writeCapable
        ? await ctx.prepareAgentWorkspace!({ agentId, capabilities, signal: ctx.signal })
        : undefined;
      if (writeCapable) ctx.writeGuard.inFlight++;
      let workspaceOutcome: 'completed' | 'failed' | 'cancelled' = 'failed';
      try {
        const sub = await executor.execute(
          call.prompt,
          { name: call.options?.agentType ?? 'workflow-agent', systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT, availableTools: tools },
          ctx.deriveSubagentContext({ agentId, modelConfig, signal: ctx.signal, capabilities, workspace }),
        );
        actualTokens = sub.tokensUsed ?? 0; // 成功或失败（return-style）都已消耗，先记账
        if (!sub.success) {
          workspaceOutcome = ctx.signal.aborted ? 'cancelled' : 'failed';
          throw new Error(sub.error ?? `子 agent 执行失败（${sub.cancellationReason ?? 'unknown'}）`);
        }
        workspaceOutcome = 'completed';
        result = sub.output;
      } catch (e) {
        // execute() 真抛异常（provider 产出部分 output 后崩）时也可能已消耗 token，从 error 上取回
        // （subagentExecutor 最外层 catch 把 outputTokensUsed 挂上）以免漏计（Codex R2 MED#4）。
        const carried = (e as { tokensUsed?: number } | null)?.tokensUsed;
        if (typeof carried === 'number') actualTokens = carried;
        if (ctx.signal.aborted) workspaceOutcome = 'cancelled';
        throw e;
      } finally {
        if (writeCapable) ctx.writeGuard.inFlight--;
        if (workspace) {
          try {
            const handoff = await ctx.finishAgentWorkspace!({ agentId, workspace, outcome: workspaceOutcome });
            ctx.handoffs.push({ agentId, ...handoff });
            if (handoff.status === 'preserved') {
              ctx.emit({
                runId: ctx.runId,
                type: 'run:log',
                ts: ctx.now(),
                data: {
                  message: `writer ${agentId} changes preserved for review on ${handoff.branchName}`,
                  handoff: { agentId, ...handoff },
                },
              });
            }
          } catch (error) {
            ctx.handoffs.push({
              agentId,
              status: 'error',
              branchName: workspace.branchName,
              cwd: workspace.cwd,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    ctx.emit({
      runId: ctx.runId,
      type: 'agent:done',
      ts: ctx.now(),
      data: { agentId, label, resultPreview: previewResult(result) },
    });
    // 仅成功调用写 journal（失败不写 → resume 时自然 miss 重跑）。actualTokens 为本次真实消耗。
    ctx.recordCall?.({ callIndex, contentHash, result, tokensUsed: actualTokens, label, ts: ctx.now() });
    return result;
  } catch (err) {
    ctx.emit({
      runId: ctx.runId,
      type: 'agent:error',
      ts: ctx.now(),
      data: { agentId, label, error: redactSecrets(err instanceof Error ? err.message : String(err)) },
    });
    throw err;
  } finally {
    // 只在真正预留过时 commit（reserveOrThrow 抛出 = 未预留，commit 会错误释放别人的额度）。
    if (reservedDone) ctx.budget.commit(reserved, actualTokens);
    release();
  }
}

/**
 * 单轮 forced structured output：强制模型调一次 structured_output 工具，取 arguments 作结果。
 * 不走 agent loop——这是命令式控制流稳定结构化值的来源（艾克斯要求并入 P1）。
 */
async function runForcedStructured(
  prompt: string,
  schema: JsonSchema,
  modelConfig: ModelConfig,
  signal: AbortSignal,
): Promise<{ value?: Record<string, unknown>; outputTokens: number; missingToolCall?: boolean }> {
  // 模型给的 schema 零校验直传会让任意值进 forced tool_choice inputSchema（deferred 审计点）。
  // 先校验是对象型且带 properties 的合规 JSON Schema，不合法直接抛、不发起 inference。
  const schemaCheck = validateForcedSchema(schema);
  if (!schemaCheck.ok) {
    throw new Error(`agent({schema}) 的 schema 非法: ${schemaCheck.error}`);
  }
  const tool: ToolDefinition = {
    name: STRUCTURED_OUTPUT_TOOL,
    description: '返回符合给定 schema 的结构化结果。你必须调用此工具输出最终答案。',
    // schema 已过 validateForcedSchema；JsonSchema 故意放宽为 Record，此处桥接。
    inputSchema: schema as unknown as ToolDefinition['inputSchema'],
    requiresPermission: false,
    permissionLevel: 'read',
  };
  const messages: ModelMessage[] = [{ role: 'user', content: prompt }];
  const response = await inferenceViaAiSdk(messages, [tool], modelConfig, undefined, signal, {
    forceNonStreaming: true,
    toolChoice: { type: 'tool', toolName: STRUCTURED_OUTPUT_TOOL },
  });
  const outputTokens = response.usage?.outputTokens ?? 0;
  const toolCall =
    response.toolCalls?.find((c) => c.name === STRUCTURED_OUTPUT_TOOL) ?? response.toolCalls?.[0];
  // 没拿到 tool call 也已消耗 token：回传 outputTokens + missingToolCall 标记，由 caller 在
  // finally 里照常 commit 后再抛（Codex HIGH#2：失败路径不能漏计）。
  if (!toolCall) {
    return { outputTokens, missingToolCall: true };
  }
  return { value: toolCall.arguments, outputTokens };
}
