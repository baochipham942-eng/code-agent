import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash2,
  Download,
  FileAudio,
  Loader2,
  Mic2,
  RefreshCw,
  X,
} from 'lucide-react';
import type { VoiceCallSummary, VoiceTokenUsage } from '@shared/contract/voice';
import { estimateRealtimeVoiceCost } from '@shared/pricing/estimateRealtimeVoiceCost';
import { useI18n } from '../../../hooks/useI18n';
import { useUIStore } from '../../../stores/uiStore';
import { Z_LAYERS } from '../../../styles/zLayers';
import { Modal } from '../../primitives';

export type VoiceAuditStatus = 'ok' | 'none' | 'unavailable';

export interface VoiceCallListItem {
  voiceCallId: string | null;
  summaryMessageId: string;
  neoSessionId: string;
  summary: VoiceCallSummary;
}

interface AuditSection<T> {
  status: VoiceAuditStatus;
  note?: string;
  events: T[];
}

interface TranscriptEvent {
  at: number;
  role: string;
  text: string;
  keyMatch: 'exact' | 'window';
}

interface LogEvent {
  at: number;
  kind: string;
  detail: Record<string, unknown>;
}

interface DispatchEvent {
  at: number;
  workItemId?: string;
  title: string;
  origin: string;
  keyMatch: 'exact' | 'window';
}

interface ApprovalEvent {
  at: number;
  toolName: string;
  summary: string | null;
  outcome: string;
  reason: string;
  waitMs: number | null;
  phase: 'during_call' | 'after_call';
}

export interface VoiceCallTimeline {
  call: VoiceCallListItem;
  sections: {
    transcript: AuditSection<TranscriptEvent>;
    decisions: AuditSection<LogEvent>;
    sayDo: AuditSection<LogEvent>;
    dispatches: AuditSection<DispatchEvent>;
    approvals: AuditSection<ApprovalEvent>;
    outcomes: AuditSection<LogEvent>;
  };
  cost: {
    status: VoiceAuditStatus;
    note?: string;
    durationSec: number;
    tokens?: VoiceTokenUsage;
  };
  recording: {
    status: VoiceAuditStatus;
    note?: string;
    dir?: string;
    files?: string[];
  };
}

export interface VoiceAuditDialogProps {
  sessionId: string;
  sessionTitle?: string;
  onClose: () => void;
}

export function filterVoiceCallsForSession(calls: VoiceCallListItem[], sessionId: string): VoiceCallListItem[] {
  return calls
    .filter((call) => call.neoSessionId === sessionId)
    .sort((a, b) => b.summary.startedAt - a.summary.startedAt);
}

export function voiceAuditStatusClass(status: VoiceAuditStatus): string {
  if (status === 'none') return 'border-zinc-600/70 bg-zinc-800/60 text-zinc-300';
  if (status === 'unavailable') return 'border-amber-500/40 bg-amber-500/10 text-mark-warning';
  return 'border-emerald-500/30 bg-emerald-500/10 text-mark-success';
}

function withToken(path: string): string {
  const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__;
  if (typeof token !== 'string' || !token) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCost(summary: VoiceCallSummary): string | null {
  if (!summary.tokens) return null;
  const estimate = estimateRealtimeVoiceCost(summary.conversationModel, summary.tokens);
  if (!estimate) return null;
  const symbol = estimate.currency === 'CNY' ? '¥' : estimate.currency === 'USD' ? '$' : `${estimate.currency} `;
  return `${symbol}${estimate.amount.toFixed(3)}`;
}

function formatDetail(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([key]) => key !== 'voiceSessionId' && key !== 'voiceCallId')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
}

const EventTime: React.FC<{ at: number }> = ({ at }) => (
  <time className="shrink-0 font-mono text-[11px] text-zinc-500">
    {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
  </time>
);

const Pill: React.FC<{ children: React.ReactNode; tone?: 'default' | 'host' | 'warn' }> = ({
  children,
  tone = 'default',
}) => (
  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
    tone === 'host'
      ? 'border-sky-400/40 bg-sky-400/10 text-mark-info'
      : tone === 'warn'
        ? 'border-amber-400/40 bg-amber-400/10 text-mark-warning'
        : 'border-white/10 bg-white/[0.04] text-zinc-300'
  }`}>
    {children}
  </span>
);

const StatusBadge: React.FC<{ status: VoiceAuditStatus }> = ({ status }) => {
  const { t } = useI18n();
  const labels = t.voiceAudit;
  const label = status === 'ok' ? labels.statusOk : status === 'none' ? labels.statusNone : labels.statusUnavailable;
  const Icon = status === 'ok' ? CheckCircle2 : status === 'none' ? CircleSlash2 : AlertTriangle;
  return (
    <span
      data-testid={`voice-audit-status-${status}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${voiceAuditStatusClass(status)}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
};

const Section: React.FC<{
  title: string;
  status: VoiceAuditStatus;
  note?: string;
  count?: number;
  children?: React.ReactNode;
}> = ({ title, status, note, count, children }) => {
  const { t } = useI18n();
  return (
    <section className="rounded-xl border border-white/[0.08] bg-zinc-950/35 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        <StatusBadge status={status} />
        {status === 'ok' && count !== undefined && (
          <span className="text-[11px] text-zinc-500">{t.voiceAudit.eventCount.replace('{count}', String(count))}</span>
        )}
      </div>
      {note && (
        <p className={`mb-3 rounded-lg border px-3 py-2 text-xs leading-5 ${voiceAuditStatusClass(status)}`}>
          {note}
        </p>
      )}
      {children}
    </section>
  );
};

const LoadingState: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-zinc-400">
    <Loader2 className="h-4 w-4 animate-spin" />
    {label}
  </div>
);

export const VoiceAuditDialog: React.FC<VoiceAuditDialogProps> = ({ sessionId, sessionTitle, onClose }) => {
  const { t } = useI18n();
  const labels = t.voiceAudit;
  const showToast = useUIStore((state) => state.showToast);
  const [calls, setCalls] = useState<VoiceCallListItem[] | null>(null);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<VoiceCallTimeline | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const loadCalls = useCallback(async () => {
    setCalls(null);
    setCallsError(null);
    setTimeline(null);
    setTimelineError(null);
    try {
      const response = await fetch(withToken('/api/voice/calls?limit=500'));
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
      const payload = await response.json() as { calls?: VoiceCallListItem[] };
      const filtered = filterVoiceCallsForSession(payload.calls ?? [], sessionId);
      setCalls(filtered);
      setSelectedId(filtered[0] ? (filtered[0].voiceCallId ?? filtered[0].summaryMessageId) : null);
    } catch (error) {
      setCallsError(errorMessage(error));
    }
  }, [sessionId]);

  useEffect(() => { void loadCalls(); }, [loadCalls]);

  useEffect(() => {
    if (!selectedId) {
      setTimeline(null);
      return;
    }
    let cancelled = false;
    setTimeline(null);
    setTimelineError(null);
    void fetch(withToken(`/api/voice/calls/${encodeURIComponent(selectedId)}/timeline`))
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
        return response.json() as Promise<VoiceCallTimeline>;
      })
      .then((value) => { if (!cancelled) setTimeline(value); })
      .catch((error) => { if (!cancelled) setTimelineError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const selectedCall = useMemo(
    () => calls?.find((call) => (call.voiceCallId ?? call.summaryMessageId) === selectedId) ?? null,
    [calls, selectedId],
  );

  const exportMarkdown = useCallback(async () => {
    if (!selectedId || !selectedCall) return;
    setExporting(true);
    try {
      const response = await fetch(withToken(
        `/api/voice/calls/${encodeURIComponent(selectedId)}/timeline?format=markdown`,
      ));
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
      const markdown = await response.text();
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `voice-audit-${selectedCall.voiceCallId ?? selectedCall.summaryMessageId}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast('success', labels.exportDone);
    } catch (error) {
      showToast('error', labels.exportFailed.replace('{message}', errorMessage(error)));
    } finally {
      setExporting(false);
    }
  }, [labels, selectedCall, selectedId, showToast]);

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="rounded-lg bg-violet-500/15 p-2 text-mark-accent"><Mic2 className="h-4 w-4" /></div>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-zinc-100">{labels.title}</h2>
        {sessionTitle && <p className="truncate text-xs text-zinc-500">{sessionTitle}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t.common.close}
        className="ml-auto rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      header={header}
      size="full"
      className="!h-[82vh] !w-[88vw] !max-w-[1240px]"
      zIndex={Z_LAYERS.criticalOverlay}
      footer={selectedCall ? (
        <div className="flex w-full justify-end">
          <button
            type="button"
            disabled={exporting || !timeline}
            onClick={() => { void exportMarkdown(); }}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3 py-2 text-xs font-medium text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {exporting ? labels.exporting : labels.exportMarkdown}
          </button>
        </div>
      ) : undefined}
    >
      {calls === null && !callsError && <LoadingState label={labels.loadingCalls} />}
      {callsError && (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle className="h-8 w-8 text-mark-danger" />
          <p className="text-sm text-mark-danger">{labels.callsError.replace('{message}', callsError)}</p>
          <button type="button" onClick={() => { void loadCalls(); }} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-200 hover:bg-white/[0.05]">
            <RefreshCw className="h-3.5 w-3.5" />{labels.retry}
          </button>
        </div>
      )}
      {calls?.length === 0 && (
        <div data-testid="voice-audit-empty" className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
          <CircleSlash2 className="mb-4 h-10 w-10 text-zinc-500" />
          <h3 className="text-base font-semibold text-zinc-200">{labels.emptySession}</h3>
          <p className="mt-2 max-w-md text-sm text-zinc-500">{labels.emptySessionHint}</p>
        </div>
      )}
      {calls && calls.length > 0 && (
        <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)] overflow-hidden">
          <aside className="overflow-y-auto border-r border-white/[0.08] bg-zinc-950/30 p-3">
            <div className="mb-3 flex items-center justify-between px-1">
              <h3 className="text-xs font-semibold text-zinc-300">{labels.callList}</h3>
              <span className="text-[11px] text-zinc-500">{labels.callCount.replace('{count}', String(calls.length))}</span>
            </div>
            <div className="space-y-2">
              {calls.map((call) => {
                const id = call.voiceCallId ?? call.summaryMessageId;
                const cost = formatCost(call.summary);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelectedId(id)}
                    className={`w-full rounded-lg border p-3 text-left transition-colors ${
                      selectedId === id
                        ? 'border-violet-400/50 bg-violet-500/10'
                        : 'border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.05]'
                    }`}
                  >
                    <div className="text-xs font-medium text-zinc-200">{new Date(call.summary.startedAt).toLocaleString()}</div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-zinc-500">
                      <span>{labels.duration}<b className="mt-0.5 block text-zinc-300">{labels.seconds.replace('{value}', String(call.summary.durationSec))}</b></span>
                      <span>{labels.dispatchCount}<b className="mt-0.5 block text-zinc-300">{call.summary.workItemCount}</b></span>
                      <span>{labels.cost}<b className="mt-0.5 block text-zinc-300">{cost ?? labels.costUnavailable}</b></span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
          <main className="overflow-y-auto p-5">
            {!timeline && !timelineError && <LoadingState label={labels.loadingTimeline} />}
            {timelineError && (
              <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
                <AlertTriangle className="h-8 w-8 text-mark-danger" />
                <p className="text-sm text-mark-danger">{labels.timelineError.replace('{message}', timelineError)}</p>
                <button type="button" onClick={() => { const id = selectedId; setSelectedId(null); queueMicrotask(() => setSelectedId(id)); }} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-200 hover:bg-white/[0.05]">
                  <RefreshCw className="h-3.5 w-3.5" />{labels.retry}
                </button>
              </div>
            )}
            {timeline && <TimelineContent timeline={timeline} />}
          </main>
        </div>
      )}
    </Modal>
  );
};

const TimelineContent: React.FC<{ timeline: VoiceCallTimeline }> = ({ timeline }) => {
  const { t } = useI18n();
  const labels = t.voiceAudit;
  const { sections, cost, recording } = timeline;
  const costEstimate = cost.tokens
    ? estimateRealtimeVoiceCost(timeline.call.summary.conversationModel, cost.tokens)
    : null;
  return (
    <div className="space-y-4" data-testid="voice-audit-timeline">
      <Section title={labels.transcript} status={sections.transcript.status} note={sections.transcript.note} count={sections.transcript.events.length}>
        <div className="space-y-2">
          {sections.transcript.events.map((event, index) => (
            <div key={`${event.at}-${index}`} className="flex gap-3 rounded-lg bg-white/[0.025] px-3 py-2.5">
              <EventTime at={event.at} />
              <div className="min-w-0 text-xs leading-5 text-zinc-200">
                <div className="mb-1 flex gap-1.5"><Pill>{event.role === 'user' ? labels.user : event.role === 'assistant' ? labels.assistant : event.role}</Pill>{event.keyMatch === 'window' && <Pill tone="warn">{labels.windowMatched}</Pill>}</div>
                {event.text}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <section className="rounded-xl border border-white/[0.08] bg-zinc-950/35 p-4">
        <h3 className="mb-3 text-sm font-semibold text-zinc-100">{labels.decisions}</h3>
        <div className="space-y-3">
          {([
            [labels.interruptDecisions, sections.decisions],
            [labels.sayDo, sections.sayDo],
          ] as const).map(([title, section]) => (
            <div key={title} className="rounded-lg border border-white/[0.07] p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2"><h4 className="text-xs font-medium text-zinc-200">{title}</h4><StatusBadge status={section.status} /></div>
              {section.note && <p className={`mb-2 rounded-md border px-2.5 py-2 text-xs leading-5 ${voiceAuditStatusClass(section.status)}`}>{section.note}</p>}
              <div className="space-y-2">
                {section.events.map((event, index) => (
                  <div key={`${event.at}-${index}`} className="flex gap-3 rounded-md bg-white/[0.025] px-3 py-2">
                    <EventTime at={event.at} />
                    <div className="min-w-0 text-xs text-zinc-300">
                      <div className="mb-1.5 flex flex-wrap gap-1.5"><Pill>{event.kind}</Pill>{typeof event.detail.layer === 'string' && <Pill tone="host">{labels.decisionLayer.replace('{value}', event.detail.layer)}</Pill>}{typeof event.detail.evidenceTier === 'string' && <Pill>{labels.evidenceTier.replace('{value}', event.detail.evidenceTier)}</Pill>}</div>
                      <p className="break-words leading-5 text-zinc-400">{formatDetail(event.detail)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <Section title={labels.dispatches} status={sections.dispatches.status} note={sections.dispatches.note} count={sections.dispatches.events.length}>
        <div className="space-y-2">
          {sections.dispatches.events.map((event, index) => (
            <div key={`${event.at}-${index}`} className="flex gap-3 rounded-lg bg-white/[0.025] px-3 py-2.5">
              <EventTime at={event.at} />
              <div className="min-w-0 text-xs text-zinc-200"><div className="mb-1.5 flex flex-wrap gap-1.5"><Pill tone={event.origin === 'host_routed' ? 'host' : 'default'}>{event.origin === 'host_routed' ? labels.hostRouted : labels.modelRouted}</Pill><Pill>{event.origin}</Pill>{event.keyMatch === 'window' && <Pill tone="warn">{labels.windowMatched}</Pill>}</div><p>{event.title}</p>{event.workItemId && <p className="mt-1 font-mono text-[10px] text-zinc-500">{event.workItemId}</p>}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={labels.approvals} status={sections.approvals.status} note={sections.approvals.note} count={sections.approvals.events.length}>
        <div className="space-y-2">
          {sections.approvals.events.map((event, index) => (
            <div key={`${event.at}-${index}`} className="flex gap-3 rounded-lg bg-white/[0.025] px-3 py-2.5">
              <EventTime at={event.at} />
              <div className="min-w-0 text-xs text-zinc-200"><div className="mb-1.5 flex flex-wrap gap-1.5"><Pill>{event.toolName}</Pill><Pill tone={event.phase === 'after_call' ? 'warn' : 'default'}>{event.phase === 'after_call' ? labels.afterCall : labels.duringCall}</Pill><Pill>{labels.outcome}: {event.outcome}</Pill></div>{event.summary && <p>{event.summary}</p>}<p className="mt-1 text-zinc-500">{labels.reason}: {event.reason}{event.waitMs !== null ? ` · ${labels.waited.replace('{ms}', String(event.waitMs))}` : ''}</p></div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={labels.cost} status={cost.status} note={cost.note}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label={labels.duration} value={labels.seconds.replace('{value}', String(cost.durationSec))} />
          {costEstimate && <Metric label={labels.cost} value={`${costEstimate.currency === 'CNY' ? '¥' : '$'}${costEstimate.amount.toFixed(3)}`} />}
          {cost.tokens && <><Metric label={labels.totalTokens} value={cost.tokens.totalTokens} /><Metric label={labels.inputTokens} value={cost.tokens.inputTokens} /><Metric label={labels.outputTokens} value={cost.tokens.outputTokens} /><Metric label={labels.inputAudioTokens} value={cost.tokens.inputAudioTokens} /><Metric label={labels.inputTextTokens} value={cost.tokens.inputTextTokens} /><Metric label={labels.outputAudioTokens} value={cost.tokens.outputAudioTokens} /><Metric label={labels.outputTextTokens} value={cost.tokens.outputTextTokens} /></>}
        </div>
      </Section>

      <Section title={labels.outcomes} status={sections.outcomes.status} note={sections.outcomes.note} count={sections.outcomes.events.length}>
        <div className="space-y-2">{sections.outcomes.events.map((event, index) => <div key={`${event.at}-${index}`} className="flex gap-3 rounded-lg bg-white/[0.025] px-3 py-2.5"><EventTime at={event.at} /><div className="min-w-0 text-xs text-zinc-300"><Pill>{event.kind}</Pill><p className="mt-1.5 break-words leading-5 text-zinc-400">{formatDetail(event.detail)}</p></div></div>)}</div>
      </Section>

      <Section title={labels.recording} status={recording.status} note={recording.note} count={recording.files?.length}>
        {recording.dir && <div className="rounded-lg bg-white/[0.025] p-3 text-xs text-zinc-300"><div className="mb-2 flex items-center gap-2"><FileAudio className="h-4 w-4 text-mark-accent" /><span>{labels.recordingDirectory}</span></div><p className="break-all font-mono text-[11px] text-zinc-500">{recording.dir}</p>{recording.files && <ul className="mt-2 space-y-1">{recording.files.map((file) => <li key={file}>{file}</li>)}</ul>}</div>}
      </Section>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-3">
    <p className="text-[10px] text-zinc-500">{label}</p>
    <p className="mt-1 text-sm font-medium text-zinc-200">{value}</p>
  </div>
);

export default VoiceAuditDialog;
