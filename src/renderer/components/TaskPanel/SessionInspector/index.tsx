// ============================================================================
// SessionInspector —— 会话检查器（N-LEDGER-P1，挂 TaskPanel 深度视图，D2）
// ----------------------------------------------------------------------------
// 数据全部走 P0B 三个 trace 路由，前端纯投影、不建第二份数据：
//   层1 人话时间线：每轮一行「读了什么 / 做了什么 / 花了多少 / 结局如何」，
//     轮头显示印章（verified=完成有据 / self_claimed=自称完成 / n_a 按终态说人话）。
//   层2 DevTools：点开任一轮——模型真实请求还原（manifest 三态：有清单→还原视图 /
//     存量会话无清单→「不可回放」/ 清单降级→如实标注）、逐 step 工具调用与裁决、
//     token / cacheRead / 结束原因。
//   「本会话实际组装」面板：实际生效的工具面 / 提示词段 / 压缩 / 验证，
//     从最新 manifest 与账本事件投影，账本没记的如实说「未记录」。
// 活会话跟随：打开期间用 tail 游标增量拉新事件，不整页重拉。
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  XCircle,
} from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionStore } from '../../../stores/sessionStore';
import {
  fetchSessionTrace,
  tailSessionTrace,
  type TraceSessionRead,
} from '../../../services/traceLedgerClient';
import {
  applyTail,
  buildAssemblyModel,
  formatTokenCount,
  segmentTurns,
  type AssemblyModel,
  type RequestManifestView,
  type TurnSegment,
} from './model';

const TAIL_POLL_MS = 2500;

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, value),
    template,
  );
}

// ── 印章 chip：verified / self_claimed 可区分但不刺眼；n_a 按终态说人话 ────

export function StampChip({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const stamp = t.sessionInspector.stamp;
  if (segment.inProgress) {
    return (
      <span
        data-testid="inspector-stamp"
        data-verdict="in_progress"
        className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-surface-faint px-1.5 py-0.5 text-[10px] text-zinc-400"
      >
        <CircleDot className="h-3 w-3" />
        {t.sessionInspector.turnInProgress}
      </span>
    );
  }
  if (!segment.stamp) return null;
  const { verdict, terminal } = segment.stamp;
  if (verdict === 'verified') {
    return (
      <span
        data-testid="inspector-stamp"
        data-verdict="verified"
        className="inline-flex items-center gap-1 rounded-md border border-badge-success/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-badge-success"
      >
        <CheckCircle2 className="h-3 w-3" />
        {stamp.verified}
        {segment.stamp.evidenceCount > 0 && (
          <span className="opacity-70">
            · {fill(t.sessionInspector.evidenceCount, { count: String(segment.stamp.evidenceCount) })}
          </span>
        )}
      </span>
    );
  }
  if (verdict === 'self_claimed') {
    return (
      <span
        data-testid="inspector-stamp"
        data-verdict="self_claimed"
        className="inline-flex items-center gap-1 rounded-md border border-badge-warning/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-badge-warning"
      >
        <AlertTriangle className="h-3 w-3" />
        {stamp.selfClaimed}
      </span>
    );
  }
  // n_a：按终态说人话（失败/取消自带原因，不判真伪）
  const label = terminal === 'cancelled'
    ? stamp.cancelled
    : terminal === 'interrupted'
      ? stamp.interrupted
      : terminal === 'failed'
        ? stamp.failed
        : terminal === 'aborted'
          ? stamp.aborted
          : terminal === 'goal_met'
            ? stamp.goalMet
            : stamp.ended;
  const tone = terminal === 'failed' || terminal === 'aborted'
    ? 'border-badge-danger/30 bg-red-500/10 text-badge-danger'
    : 'border-white/[0.08] bg-surface-faint text-zinc-400';
  return (
    <span
      data-testid="inspector-stamp"
      data-verdict="n_a"
      data-terminal={terminal ?? 'unknown'}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${tone}`}
    >
      {(terminal === 'failed' || terminal === 'aborted') && <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}

// ── 层1：一轮的人话摘要行 ────────────────────────────────────────────────

function TurnActivitySummary({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const activity = t.sessionInspector.activity;
  const parts: string[] = [];
  if (segment.toolCounts.read > 0) parts.push(fill(activity.read, { count: String(segment.toolCounts.read) }));
  if (segment.toolCounts.write > 0) parts.push(fill(activity.write, { count: String(segment.toolCounts.write) }));
  if (segment.toolCounts.command > 0) parts.push(fill(activity.command, { count: String(segment.toolCounts.command) }));
  if (segment.toolCounts.browser > 0) parts.push(fill(activity.browser, { count: String(segment.toolCounts.browser) }));
  if (segment.toolCounts.other > 0) parts.push(fill(activity.otherTool, { count: String(segment.toolCounts.other) }));
  const totalTokens = segment.tokens.input + segment.tokens.output;
  return (
    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-zinc-500">
      <span data-testid="inspector-turn-activity">
        {parts.length > 0 ? parts.join(' · ') : activity.none}
        {segment.failedToolCount > 0 && (
          <span className="text-badge-warning">{fill(activity.failed, { count: String(segment.failedToolCount) })}</span>
        )}
      </span>
      {totalTokens > 0 && (
        <span data-testid="inspector-turn-tokens" className="text-zinc-600">
          {fill(t.sessionInspector.tokenUsage, { tokens: formatTokenCount(totalTokens) })}
          {segment.tokens.cacheRead > 0 && `（${fill(t.sessionInspector.tokenCacheRead, { tokens: formatTokenCount(segment.tokens.cacheRead) })}）`}
        </span>
      )}
    </div>
  );
}

// ── 层2：一轮的 DevTools（manifest 三态 + 逐 step 工具与裁决 + token）─────

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

function TurnDevtools({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const dt = t.sessionInspector.devtools;
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
        {segment.toolDispatches.length === 0 && segment.decisions.length === 0 ? (
          <div className="text-[11px] text-zinc-500">{dt.noSteps}</div>
        ) : (
          <div className="space-y-0.5" data-testid="inspector-steps">
            {segment.toolDispatches.map((row, index) => (
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
      </section>
      {segment.inferences.length > 0 && (
        <section>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">{dt.inferenceTitle}</div>
          <div className="space-y-0.5" data-testid="inspector-inferences">
            {segment.inferences.map((row, index) => (
              <div key={index} className="text-[11px] text-zinc-400">
                {`in ${formatTokenCount(row.inputTokens)} / out ${formatTokenCount(row.outputTokens)}`}
                {row.cacheReadTokens > 0 && ` / cache ${formatTokenCount(row.cacheReadTokens)}`}
                {row.finishReason && ` · ${fill(dt.finishReason, { reason: row.finishReason })}`}
                {row.truncated && dt.truncated}
                {row.durationMs !== null && ` · ${fill(dt.durationMs, { ms: String(Math.round(row.durationMs)) })}`}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── 层1 轮行（点开展开层2）───────────────────────────────────────────────

function TurnRow({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="inspector-turn" className="px-0.5 py-1">
      <button /* ds-allow:button: 轮行展开钮是整行超小文本按钮，primitive 最小档仍过大 */
        type="button"
        data-testid="inspector-turn-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" /> : <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500" />}
        <span className="shrink-0 text-xs font-medium text-zinc-300">
          {fill(t.sessionInspector.turnLabel, { count: String(segment.index) })}
        </span>
        <StampChip segment={segment} />
        {segment.startedAt !== null && (
          <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
            {new Date(segment.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </button>
      <div className="pl-5">
        <TurnActivitySummary segment={segment} />
        {open && <TurnDevtools segment={segment} />}
      </div>
    </div>
  );
}

// ── 「本会话实际组装」面板 ────────────────────────────────────────────────

function AssemblyPanel({ model }: { model: AssemblyModel }) {
  const { t } = useI18n();
  const assembly = t.sessionInspector.assembly;
  const [open, setOpen] = useState(false);
  const value = (text: string | null) => text ?? assembly.notRecorded;
  return (
    <section data-testid="inspector-assembly" aria-label={assembly.sectionLabel} className="px-0.5">
      <button /* ds-allow:button: 面板折叠钮是超小文本按钮（同概览 materials 行范式） */
        type="button"
        data-testid="inspector-assembly-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-300"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{assembly.sectionLabel}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-4 text-[11px]" data-testid="inspector-assembly-body">
          {model.degraded && <div className="text-[10px] text-badge-warning">{assembly.degradedNote}</div>}
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-zinc-600">{assembly.model}</span>
            <span className="text-zinc-300">{value(model.model)}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-zinc-600">{assembly.engine}</span>
            <span className="text-zinc-300">{value(model.engine)}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-zinc-600">{assembly.appVersion}</span>
            <span className="text-zinc-300">{value(model.appVersion)}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-zinc-600">{assembly.tools}</span>
            <span className="min-w-0 break-all text-zinc-300" title={model.toolNames.join(', ')}>
              {model.hasManifest
                ? `${fill(assembly.toolsSummary, { count: String(model.toolNames.length) })}${model.toolNames.length > 0 ? `：${model.toolNames.join(', ')}` : ''}`
                : assembly.notRecorded}
            </span>
          </div>
          {model.toolSchemaHash && (
            <div className="flex gap-2">
              <span className="w-20 shrink-0 text-zinc-600">{assembly.toolSchemaHash}</span>
              <span className="font-mono text-[10px] text-zinc-500">{model.toolSchemaHash.slice(0, 16)}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-zinc-600">{assembly.promptSegments}</span>
            <span className="text-zinc-300">
              {model.hasManifest
                ? fill(assembly.promptSegmentSummary, {
                    system: String(model.promptSegments.systemPrompt),
                    ledger: String(model.promptSegments.ledgerMessage),
                    tail: String(model.promptSegments.dynamicTail),
                    injected: String(model.promptSegments.runtimeInjection),
                    rewritten: String(model.promptSegments.postAssemblyRewrite),
                  })
                : assembly.notRecorded}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-zinc-600">{assembly.compaction}</span>
            <span className="text-zinc-300">
              {model.compactionCount > 0 ? fill(assembly.compactionSummary, { count: String(model.compactionCount) }) : assembly.compactionNone}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-zinc-600">{assembly.verification}</span>
            <span className="text-zinc-300">
              {model.verificationCount > 0
                ? `${fill(assembly.verificationSummary, { count: String(model.verificationCount) })}${model.verificationSkippedCount > 0 ? ` · ${fill(assembly.verificationSkipped, { count: String(model.verificationSkippedCount) })}` : ''}`
                : assembly.verificationNone}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

// ── 根组件：整读 + tail 跟随 ─────────────────────────────────────────────

export const SessionInspector: React.FC = () => {
  const { t } = useI18n();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const [read, setRead] = useState<TraceSessionRead | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const cursorRef = useRef(0);
  const inFlightRef = useRef(false);

  // 整读（切会话 / 初次打开 / 失败后重试）
  useEffect(() => {
    let cancelled = false;
    setRead(null);
    setLoadFailed(false);
    cursorRef.current = 0;
    if (!currentSessionId) return;
    void fetchSessionTrace(currentSessionId).then((result) => {
      if (cancelled) return;
      if (!result) {
        setLoadFailed(true);
        return;
      }
      cursorRef.current = result.cursor;
      setRead(result);
    });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  // 活会话跟随：tail 游标增量，不整页重拉
  const pollTail = useCallback(async () => {
    if (!currentSessionId || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const tail = await tailSessionTrace(currentSessionId, cursorRef.current);
      if (!tail) return;
      cursorRef.current = Math.max(cursorRef.current, tail.cursor);
      setLoadFailed(false);
      setRead((previous) => (previous ? applyTail(previous, tail) : tail));
    } finally {
      inFlightRef.current = false;
    }
  }, [currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) return;
    const timer = setInterval(() => void pollTail(), TAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [currentSessionId, pollTail]);

  if (!currentSessionId) {
    return <div className="px-0.5 text-xs text-zinc-500">{t.sessionInspector.noSession}</div>;
  }
  if (!read) {
    return (
      <div className="px-0.5 text-xs text-zinc-500" data-testid="inspector-load-failed">
        {loadFailed ? t.sessionInspector.loadFailed : t.sessionInspector.stateMissing}
      </div>
    );
  }
  if (read.state === 'missing') {
    return <div className="px-0.5 text-xs text-zinc-500" data-testid="inspector-state-missing">{t.sessionInspector.stateMissing}</div>;
  }

  const segments = segmentTurns(read.events);
  const assemblyModel = buildAssemblyModel(read.events);

  return (
    <div className="space-y-3" data-testid="session-inspector">
      {read.skippedLines > 0 && (
        <div
          role="status"
          data-testid="inspector-skipped-lines"
          className="flex items-start gap-1.5 rounded-md border border-badge-warning/30 bg-amber-500/10 px-2 py-1 text-[11px] text-badge-warning"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {fill(t.sessionInspector.skippedLines, { count: String(read.skippedLines) })}
        </div>
      )}
      <AssemblyPanel model={assemblyModel} />
      <section aria-label={t.sessionInspector.title}>
        {segments.length === 0 || read.state === 'empty' ? (
          <div className="px-0.5 text-xs text-zinc-500" data-testid="inspector-state-empty">
            {read.state === 'empty' ? t.sessionInspector.stateEmpty : t.sessionInspector.noTurns}
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]" data-testid="inspector-timeline">
            {segments.map((segment) => (
              <TurnRow key={`${segment.index}-${segment.startedAt ?? 0}`} segment={segment} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default SessionInspector;
