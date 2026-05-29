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

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../../model/types';
import { inferenceViaAiSdk } from '../../model/adapters/aiSdkAdapter';
import { SubagentExecutor, type SubagentConfig, type SubagentContext } from '../subagentExecutor';
import { SCRIPT_RUNTIME } from '../../../shared/constants';
import type { ConcurrencyGate } from './concurrencyGate';
import type { BudgetTracker } from './budget';
import { validateForcedSchema } from './scriptValidator';
import type { AgentCallPayload, JsonSchema, PrimitiveResult, ScriptRunEvent } from './types';

const STRUCTURED_OUTPUT_TOOL = 'structured_output';

const DEFAULT_AGENT_SYSTEM_PROMPT =
  '你是 dynamic-workflow 编排脚本派发的子 agent。专注完成下面这一个明确子任务，' +
  '用给定工具收集信息或执行操作，最后给出简洁、可被脚本直接消费的结果。' +
  '不要寒暄，不要复述任务，不要输出与结果无关的过程描述。';

// 单例执行器：execute 是无状态 per-call（上下文全由参数传入），全 run 复用一个实例即可。
const executor = new SubagentExecutor();

/**
 * 一次 dynamic-workflow run 的主线程运行期上下文（非序列化，不进 worker）。
 * 由 runService 构造：注入并发闸、事件回调、以及与宿主解耦的两个工厂。
 */
export interface ScriptRunContext {
  runId: string;
  baseModelConfig: ModelConfig;
  /** 解析 per-call model override → 完整 ModelConfig（含 apiKey/baseUrl）。命令层持有 configService/settings。 */
  resolveModelConfig: (override?: { provider: string; model: string }) => ModelConfig;
  /** 为一次 full-agent 调用派生隔离的干净 SubagentContext（不灌历史）。命令层持有 toolResolver/toolContext。 */
  deriveSubagentContext: (args: { agentId: string; modelConfig: ModelConfig; signal: AbortSignal }) => SubagentContext;
  /** full-agent 路径的默认可用工具集（命令层决定，按 deferred-tools 规范名传入）。 */
  defaultAgentTools: string[];
  /** run 级取消信号。 */
  signal: AbortSignal;
  /** provider-aware 全局并发闸。 */
  gate: ConcurrencyGate;
  /** 进度/可观测事件回调（scriptRuntime 自有事件流）。 */
  emit: (event: ScriptRunEvent) => void;
  /** 跨 run 共享的 agent() 调用计数（失控脚本兜底）。 */
  callCounter: { count: number };
  /** token 预算账本（主线程权威：每次 agent() 完成累加 outputTokens，发起前查上限）。 */
  budget: BudgetTracker;
  /** 主线程计时（worker 内禁 Date.now；bridge 在主线程可用）。 */
  now: () => number;
}

/** 执行模型脚本里的一次 agent() 调用。worker 经 RPC 把调用 marshal 到主线程后落到这里。 */
export async function runAgentCall(call: AgentCallPayload, ctx: ScriptRunContext): Promise<PrimitiveResult> {
  if (ctx.callCounter.count >= SCRIPT_RUNTIME.MAX_AGENT_CALLS_PER_RUN) {
    throw new Error(`agent() 调用数超过单 run 上限 ${SCRIPT_RUNTIME.MAX_AGENT_CALLS_PER_RUN}`);
  }
  // 预算硬上限（对齐 Claude Code Workflow）：耗尽后再发起的 agent() 直接抛，让脚本能用
  // while(budget.remaining()>x) 动态收敛。enforce 在主线程、是权威；worker 侧 budget 是只读镜像。
  if (ctx.budget.exceeded()) {
    throw new Error(`token budget 已耗尽（${ctx.budget.spent()}/${ctx.budget.total}）`);
  }
  ctx.callCounter.count++;

  const modelConfig = ctx.resolveModelConfig(call.options?.model);
  const provider = modelConfig.provider;
  const label = call.options?.label ?? call.options?.phase ?? 'agent';
  const agentId = `${ctx.runId}-a${ctx.callCounter.count}`;

  const release = await ctx.gate.acquire(provider, ctx.signal);
  ctx.emit({
    runId: ctx.runId,
    type: 'agent:start',
    ts: ctx.now(),
    data: { agentId, label, provider, model: modelConfig.model, hasSchema: !!call.options?.schema },
  });

  try {
    let result: PrimitiveResult;
    if (call.options?.schema) {
      const forced = await runForcedStructured(call.prompt, call.options.schema, modelConfig, ctx.signal);
      ctx.budget.add(forced.outputTokens);
      result = forced.value;
    } else {
      const sub = await executor.execute(
        call.prompt,
        buildAgentConfig(call, ctx),
        ctx.deriveSubagentContext({ agentId, modelConfig, signal: ctx.signal }),
      );
      if (!sub.success) {
        throw new Error(sub.error ?? `子 agent 执行失败（${sub.cancellationReason ?? 'unknown'}）`);
      }
      ctx.budget.add(sub.tokensUsed ?? 0);
      result = sub.output;
    }
    ctx.emit({ runId: ctx.runId, type: 'agent:done', ts: ctx.now(), data: { agentId, label } });
    return result;
  } catch (err) {
    ctx.emit({
      runId: ctx.runId,
      type: 'agent:error',
      ts: ctx.now(),
      data: { agentId, label, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  } finally {
    release();
  }
}

function buildAgentConfig(call: AgentCallPayload, ctx: ScriptRunContext): SubagentConfig {
  return {
    name: call.options?.agentType ?? 'workflow-agent',
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    availableTools: ctx.defaultAgentTools,
  };
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
): Promise<{ value: Record<string, unknown>; outputTokens: number }> {
  // 模型给的 schema 零校验直传会让任意值进 forced tool_choice inputSchema（deferred 审计点）。
  // 先校验是对象型且带 properties 的 JSON Schema，不合法直接抛、不发起 inference。
  const schemaCheck = validateForcedSchema(schema);
  if (!schemaCheck.ok) {
    throw new Error(`agent({schema}) 的 schema 非法: ${schemaCheck.error}`);
  }
  const tool: ToolDefinition = {
    name: STRUCTURED_OUTPUT_TOOL,
    description: '返回符合给定 schema 的结构化结果。你必须调用此工具输出最终答案。',
    // schema 由模型脚本提供，运行时是合法 JSON Schema（含 type）；JsonSchema 故意放宽为 Record，此处桥接。
    inputSchema: schema as unknown as ToolDefinition['inputSchema'],
    requiresPermission: false,
    permissionLevel: 'read',
  };
  const messages: ModelMessage[] = [{ role: 'user', content: prompt }];
  const response = await inferenceViaAiSdk(messages, [tool], modelConfig, undefined, signal, {
    forceNonStreaming: true,
    toolChoice: { type: 'tool', toolName: STRUCTURED_OUTPUT_TOOL },
  });
  const toolCall =
    response.toolCalls?.find((c) => c.name === STRUCTURED_OUTPUT_TOOL) ?? response.toolCalls?.[0];
  if (!toolCall) {
    throw new Error('forced structured output：模型未返回 tool call');
  }
  return { value: toolCall.arguments, outputTokens: response.usage?.outputTokens ?? 0 };
}
