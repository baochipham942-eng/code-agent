// ============================================================================
// SessionInspector —— 会话检查器（N-LEDGER-P1，挂 TaskPanel 深度视图，D2）
// ----------------------------------------------------------------------------
// 数据全部走 P0B 三个 trace 路由，前端纯投影、不建第二份数据：
//   层1 人话时间线：每轮一行「读了什么 / 做了什么 / 结局如何」，轮头显示印章
//     （verified=完成有据 / self_claimed=自称完成 / n_a 按终态说人话）。
//     N-LEDGER-UX1 加法：A 汇总句可展开逐条明细、B 层1 撤 token 数字只报异常
//     黄条（甲口径）、C 未 settle 轮活行（settle 后原地转常规轮行）——见 turnRow.tsx。
//   层2 DevTools：点开任一轮——模型真实请求还原（manifest 三态：有清单→还原视图 /
//     存量会话无清单→「不可回放」/ 清单降级→如实标注）、逐 step 工具调用与裁决、
//     per-call 推理调用分卡（含 cacheRead；无 inference 细分降级轮级汇总）
//     ——见 turnDevtools.tsx。
//   「本会话实际组装」面板：实际生效的工具面 / 提示词段 / 压缩 / 验证，
//     从最新 manifest 与账本事件投影，账本没记的如实说「未记录」。
// 活会话跟随：打开期间用 tail 游标增量拉新事件，不整页重拉。
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionStore } from '../../../stores/sessionStore';
import {
  fetchSessionTrace,
  tailSessionTrace,
  type TraceSessionRead,
} from '../../../services/traceLedgerClient';
import { fill } from './format';
import {
  applyTail,
  buildAssemblyModel,
  segmentTurns,
  type AssemblyModel,
} from './model';
import { LiveTurnRow, TurnRow } from './turnRow';

const TAIL_POLL_MS = 2500;

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
            {segments.map((segment) =>
              // C：未 settle 的当前轮渲染活行；settle 后同 key 位置转为常规轮行
              segment.inProgress ? (
                <LiveTurnRow key={`${segment.index}-${segment.startedAt ?? 0}`} segment={segment} />
              ) : (
                <TurnRow key={`${segment.index}-${segment.startedAt ?? 0}`} segment={segment} />
              ),
            )}
          </div>
        )}
      </section>
    </div>
  );
};
