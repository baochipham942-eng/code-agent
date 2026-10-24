// ============================================================================
// inferenceMaxMode — Max Mode（best-of-N）推理分支，从 inference.ts 逐字搬出
// （N-MAXLINES-MINEFIELD-2-FU1-S1 降 god-file 行数）。逻辑/注释/日志零改动；
// runEngineInference 经参数注入（同 visionPreflight 范式），避免与 inference.ts
// 循环依赖、不扩它的导出面。
// ============================================================================
import type { ToolDefinition } from '../../../../shared/contract';
import type { ModelMessage, ModelResponse } from '../../../agent/loopTypes';
import type { StreamCallback, InferenceOptions, ModelResponse as RouterModelResponse } from '../../../model/types';
import type { ModelConfig } from '../../../../shared/contract/model';
import type { ContextAssemblyCtx } from './shared';
import { cacheOptionsForMaxModeCall } from './maxModePolicy';
import { runMaxModeStep, MaxModeAbortError, MaxModeStats, recordMaxModeOverheadUsage } from '../maxMode';

type RunEngineInference = (
  ctx: ContextAssemblyCtx,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal,
  options?: InferenceOptions,
) => Promise<RouterModelResponse>;

/**
 * Max Mode（best-of-N，roadmap 3.3）分支：N 并发 propose-only 候选 → judge 选索引 →
 * 赢家 replay（由主链路下游正常执行其工具调用）。
 *
 * 副作用隔离：候选与 judge 走无流式回调、无快照（onSnapshot 剥离）的静默引擎调用——
 * 不发 UI 流事件、不写 stream snapshot、不执行任何工具。全候选失败时降级为带
 * streamCallback 的正常单次调用，用户无感。
 *
 * 成本约束（roadmap 3.3.d）：落选候选 + judge 的 usage 作为 overhead 记入成本统计
 * （ctx.recordTokenUsage → budgetService），但不进上下文长度估算——上下文路径
 * （streamHandler 累计 ctx.stats.totalInputTokens/totalOutputTokens、line ~820 的赢家估算）
 * 只见到赢家的 response.usage。
 */
export async function runMaxModeInference(
  ctx: ContextAssemblyCtx,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  requestConfig: ModelConfig,
  streamCallback: StreamCallback,
  engineOptions: InferenceOptions,
  runEngineInference: RunEngineInference,
): Promise<ModelResponse> {
  const { onSnapshot: _onSnapshot, ...restOptions } = engineOptions;
  const silentOptions: InferenceOptions = { ...restOptions, suppressModelDecisionEvent: true };
  const judgeOptions = cacheOptionsForMaxModeCall(silentOptions, 'judge');
  const signal = ctx.runtime.control.abortController?.signal;
  const candidates = ctx.runtime.maxModeCandidates;
  ctx.taskProgress.emitTaskProgress('thinking', `Max Mode：${candidates} 个候选并行起草中...`);

  // overhead 逐条折账在 maxMode.ts 的 recordMaxModeOverheadUsage（Codex R1-M2 按
  // 实际路由模型分账；r2 起响应实报档位随条目透传，缺席 = standard 计价）——
  // 本文件已压 max-lines 硬限，折账实现不放这里。不走 ctx.recordTokenUsage：
  // 那条路径固定记在请求模型名下。
  const recordOverheadEntries = (entries: MaxModeStats['overheadEntries']) =>
    recordMaxModeOverheadUsage(ctx.runtime.budgetScope, requestConfig, ctx.runtime.sessionId, entries);

  let stepResult;
  try {
    stepResult = await runMaxModeStep(
      {
        silentEngine: (msgs, tls, kind) =>
          runEngineInference(
            ctx,
            msgs,
            tls,
            requestConfig,
            undefined,
            signal,
            kind === 'judge' ? judgeOptions : silentOptions,
          ),
        streamingEngine: (msgs, tls) =>
          runEngineInference(ctx, msgs, tls, requestConfig, streamCallback, signal, engineOptions),
        // 取消/转向/中断时丢弃整个 step（含已完成的部分赢家），走外层既有取消语义
        isAborted: () =>
          Boolean(ctx.runtime.control.isCancelled || ctx.runtime.control.isInterrupted || ctx.runtime.turn.needsReinference),
      },
      { messages, tools, candidates },
    );
  } catch (error) {
    // 中止丢弃整个 step，但已完成候选/judge 的 token 是真实花费——
    // 先记沉没成本再重抛，由外层取消语义接管（Codex R2-M1）
    if (error instanceof MaxModeAbortError) {
      recordOverheadEntries(error.overheadEntries);
    }
    throw error;
  }
  const { response, stats } = stepResult;
  recordOverheadEntries(stats.overheadEntries);
  response.runtimeDiagnostics = {
    ...response.runtimeDiagnostics,
    maxMode: {
      candidates: stats.candidates,
      survivors: stats.survivors,
      winner: stats.winner,
      degraded: stats.degraded,
      judgeParsed: stats.judgeParsed,
      overheadInputTokens: stats.overhead.inputTokens,
      overheadOutputTokens: stats.overhead.outputTokens,
    },
  };
  return response;
}
