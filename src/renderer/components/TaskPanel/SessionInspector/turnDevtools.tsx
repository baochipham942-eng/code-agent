// ============================================================================
// SessionInspector 层2 DevTools（N-LEDGER-UX1 D 项：轮内 per-call 推理调用分卡）
// ----------------------------------------------------------------------------
// 轮详情三段：
//   模型真实请求（manifest 三态：有清单→还原视图 / 无清单→「不可回放」/ 降级→如实标注）；
//   逐步工具调用与裁决（有分卡时这里只剩 orphan 工具与决策行；无 inference 细分的
//     存量会话按轮级汇总平铺并如实标注——诚实降级，不臆造）；
//   推理调用分卡：每条 inference 事件一卡（#N · 模型 · 时刻 · 耗时 · 结束原因 ·
//     in/out/cacheRead），该 call 期间的工具调用挂在卡下；单调用轮一卡即全部。
// ============================================================================

import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { fill } from './format';
import {
  formatTokenCount,
  type RequestManifestView,
  type TurnSegment,
} from './model';

function ManifestView({ manifest }: { manifest: RequestManifestView }) {
  const { t } = useI18n();
  const dt = t.sessionInspector.devtools;
  const fields = dt.manifestFields;
  const refKindLabel = (ref: RequestManifestView['messageRefs'][number]): string => {
    if (ref.kind === 'ledger_message') return dt.refKind.ledgerMessage;
    if (ref.kind === 'system_prompt') return dt.refKind.systemPrompt;
    if (ref.reason === 'dynamic_tail') return dt.refKind.dynamicTail;
    if (ref.reason === 'runtime_injection') return dt.refKind.runtimeInjection;
    if (ref.reason === 'system_prompt_fallback') return dt.refKind.systemPromptFallback;
    return dt.refKind.postAssemblyRewrite;
  };
  const sampling = [
    manifest.temperature !== null ? `temperature=${manifest.temperature}` : null,
    manifest.maxTokens !== null ? `maxTokens=${manifest.maxTokens}` : null,
    manifest.reasoningEffort !== null ? `effort=${manifest.reasoningEffort}` : null,
  ].filter(Boolean).join(' ');
  return (
    <div data-testid="inspector-manifest" data-degraded={manifest.degraded || undefined} className="space-y-1">
      {manifest.degraded && (
        <div className="text-[10px] text-badge-warning" role="note">{dt.replayDegraded}</div>
      )}
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <span className="text-zinc-600">{fields.model}</span>
        <span className="text-zinc-300">{manifest.requestedModel ?? dt.unknownValue}</span>
        <span className="text-zinc-600">{fields.actualModel}</span>
        <span className="text-zinc-300">{manifest.actualModel ?? dt.unknownValue}</span>
        <span className="text-zinc-600">{fields.engine}</span>
        <span className="text-zinc-300">{manifest.engine ?? dt.unknownValue}</span>
        <span className="text-zinc-600">{fields.appVersion}</span>
        <span className="text-zinc-300">{manifest.appVersion ?? dt.unknownValue}</span>
        {sampling && (
          <>
            <span className="text-zinc-600">{fields.sampling}</span>
            <span className="text-zinc-300">{sampling}</span>
          </>
        )}
        <span className="text-zinc-600">{fill(fields.toolSurface, { count: String(manifest.toolNames.length) })}</span>
        <span className="text-zinc-300 break-all">{manifest.toolNames.join(', ') || dt.unknownValue}</span>
        {manifest.toolSchemaHash && (
          <>
            <span className="text-zinc-600">{fields.toolSchemaHash}</span>
            <span className="font-mono text-[10px] text-zinc-500">{manifest.toolSchemaHash.slice(0, 16)}</span>
          </>
        )}
      </div>
      <div className="pt-1 text-[10px] text-zinc-600">
        {fill(fields.messageList, { count: String(manifest.messageRefs.length) })}
        {manifest.compactionReplacementCount > 0 && ` · ${fill(fields.compaction, { count: String(manifest.compactionReplacementCount) })}`}
      </div>
      <div className="space-y-0.5" data-testid="inspector-manifest-refs">
        {manifest.messageRefs.map((ref, index) => (
          <div key={index} className="flex items-baseline gap-2 text-[10px]">
            <span className="w-4 shrink-0 text-right text-zinc-700">{index + 1}</span>
            <span className="shrink-0 text-zinc-400">{refKindLabel(ref)}</span>
            {ref.hashPreview && <span className="font-mono text-zinc-600">{ref.hashPreview}</span>}
            {ref.bytes !== null && <span className="text-zinc-700">{ref.bytes}B</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── D · per-call 推理调用分卡 ────────────────────────────────────────────

function InferenceCallCards({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const dt = t.sessionInspector.devtools;
  return (
    <section>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{dt.inferenceTitle}</div>
      <div className="space-y-1.5" data-testid="inspector-inferences">
        {segment.inferenceCalls.map((call) => (
          <div
            key={call.seq}
            data-testid="inspector-inference-call"
            className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-zinc-400">
              <span className="font-medium text-zinc-300">#{call.seq}</span>
              <span>{call.model ?? dt.unknownValue}</span>
              {call.ts !== null && (
                <span className="text-zinc-600">
                  {new Date(call.ts).toLocaleTimeString(undefined, { hour12: false })}
                </span>
              )}
              {call.durationMs !== null && (
                <span className="text-zinc-600">{fill(dt.durationMs, { ms: String(Math.round(call.durationMs)) })}</span>
              )}
              {call.finishReason && <span>{fill(dt.finishReason, { reason: call.finishReason })}</span>}
              {call.truncated && <span className="text-badge-warning">{dt.truncated}</span>}
              <span className="text-zinc-500">
                {fill(dt.callTokens, {
                  input: formatTokenCount(call.inputTokens),
                  output: formatTokenCount(call.outputTokens),
                })}
                {call.cacheReadTokens > 0 && ` / ${fill(dt.callCacheRead, { tokens: formatTokenCount(call.cacheReadTokens) })}`}
              </span>
            </div>
            {call.tools.length > 0 && (
              <div className="mt-1 space-y-0.5 pl-3" data-testid="inspector-call-tools">
                {call.tools.map((row, index) => (
                  <div key={`call-tool-${index}`} className="flex items-baseline gap-2 text-[11px]">
                    <span className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${row.success ? 'bg-badge-success' : 'bg-badge-danger'}`} />
                    <span className="font-mono text-[10px] text-zinc-300">{row.toolName}</span>
                    {!row.success && <span className="text-badge-danger">{dt.toolFailed}{row.error ? `：${row.error}` : ''}</span>}
                    {row.fromCache && <span className="text-zinc-600">{dt.toolFromCache}</span>}
                    {row.durationMs !== null && (
                      <span className="ml-auto text-zinc-600">{fill(dt.durationMs, { ms: String(Math.round(row.durationMs)) })}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function TurnDevtools({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const dt = t.sessionInspector.devtools;
  const hasCalls = segment.inferenceCalls.length > 0;
  // 有分卡时平铺区只剩 orphan 工具（首条 inference 之前）+ 决策行；
  // 无 inference 细分的存量会话整轮工具平铺（轮级汇总降级）并如实标注。
  const flatTools = hasCalls ? segment.orphanToolDispatches : segment.toolDispatches;
  return (
    <div className="mt-1.5 space-y-3 rounded-md border border-white/[0.06] bg-surface-faint p-2" data-testid="inspector-devtools">
      <section>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{dt.requestTitle}</div>
        {segment.manifests.length === 0 ? (
          <div className="text-[11px] text-zinc-500" data-testid="inspector-replay-unavailable">
            {dt.replayUnavailable}
          </div>
        ) : (
          <div className="space-y-2">
            {segment.manifests.map((manifest, index) => (
              <ManifestView key={manifest.requestId ?? index} manifest={manifest} />
            ))}
          </div>
        )}
      </section>
      <section>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{dt.stepsTitle}</div>
        {flatTools.length === 0 && segment.decisions.length === 0 ? (
          <div className="text-[11px] text-zinc-500">{dt.noSteps}</div>
        ) : (
          <div className="space-y-0.5" data-testid="inspector-steps">
            {flatTools.map((row, index) => (
              <div key={`tool-${index}`} className="flex items-baseline gap-2 text-[11px]">
                <span className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${row.success ? 'bg-badge-success' : 'bg-badge-danger'}`} />
                <span className="font-mono text-[10px] text-zinc-300">{row.toolName}</span>
                {!row.success && <span className="text-badge-danger">{dt.toolFailed}{row.error ? `：${row.error}` : ''}</span>}
                {row.fromCache && <span className="text-zinc-600">{dt.toolFromCache}</span>}
                {row.durationMs !== null && (
                  <span className="ml-auto text-zinc-600">{fill(dt.durationMs, { ms: String(Math.round(row.durationMs)) })}</span>
                )}
              </div>
            ))}
            {segment.decisions.map((row, index) => (
              <div key={`decision-${index}`} className="text-[10px] text-zinc-600">
                {fill(dt.decision, { action: row.action ?? '?', reason: row.reason ?? row.stopReason ?? '' })}
              </div>
            ))}
          </div>
        )}
        {!hasCalls && segment.toolDispatches.length > 0 && (
          <div className="pt-1 text-[10px] text-zinc-600" role="note" data-testid="inspector-calls-degraded">
            {dt.callsDegraded}
          </div>
        )}
      </section>
      {hasCalls && <InferenceCallCards segment={segment} />}
    </div>
  );
}
