import React, { useEffect, useMemo, useState } from 'react';
import type { SurfaceEvidenceCardV1 } from '@shared/contract/surfaceExecution';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { formatSurfaceExecutionCopy } from '../../../i18n/surfaceExecution';
import { getSurfaceExecutionFrame } from '../../../services/surfaceExecutionClient';
import type { SurfaceExecutionScopeV1 } from '../../../utils/surfaceExecutionProjection';
import { Button } from '../../primitives';
import {
  formatSurfaceTimestamp,
  hasVerifiedInspection,
  safeSurfaceText,
} from './surfaceExecutionPresentation';

interface SurfaceEvidenceCardProps {
  evidence: SurfaceEvidenceCardV1;
  copy: SurfaceExecutionTranslationsV1;
  language: 'zh' | 'en';
  scope?: Pick<SurfaceExecutionScopeV1, 'conversationId' | 'surfaceSessionId'>;
}

type EvidencePreviewState =
  | { status: 'idle' | 'loading' | 'unavailable' }
  | { status: 'ready'; dataUrl: string; width?: number; height?: number };

const OPAQUE_FRAME_REF = /^surface-frame:\/\/[a-zA-Z0-9._:-]+$/;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/;

interface EvidenceAxisProps {
  label: string;
  value: string;
  state: string;
}

function axisTone(state: string): string {
  if (state === 'captured' || state === 'analyzed' || state === 'verified') return 'text-emerald-300';
  if (state === 'blocked' || state === 'failed' || state === 'rejected') return 'text-red-300';
  if (state === 'analyzing' || state === 'inconclusive' || state === 'incomplete') return 'text-amber-300';
  return 'text-zinc-500';
}

function EvidenceAxis({ label, value, state }: EvidenceAxisProps) {
  return (
    <div data-testid="surface-evidence-axis" data-axis={label} data-state={state} className="min-w-0">
      <dt className="text-[9px] uppercase tracking-wide text-zinc-600">{label}</dt>
      <dd className={`mt-0.5 truncate text-[10px] ${axisTone(state)}`}>{value}</dd>
    </div>
  );
}

function EvidenceChecklist({ evidence, copy }: SurfaceEvidenceCardProps) {
  if (evidence.inspection.checklist.length === 0) return null;
  return (
    <div className="mt-2 border-t border-white/[0.04] pt-2">
      <div className="text-[10px] text-zinc-600">{copy.evidence.checklist}</div>
      <ul className="mt-1 space-y-1">
        {evidence.inspection.checklist.map((item) => (
          <li key={item.id} className="flex min-w-0 items-start justify-between gap-2 text-[10px]">
            <span className="min-w-0 text-zinc-400">
              {safeSurfaceText(item.label, copy.evidence.checklist, 120)}
              {item.finding && (
                <span className="ml-1 text-zinc-600">
                  · {safeSurfaceText(item.finding, '', 140)}
                </span>
              )}
            </span>
            <span className="shrink-0 text-zinc-500">{copy.evidence.checklistState[item.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function safeSourceUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return safeSurfaceText(`${parsed.origin}${parsed.pathname}`, '', 180);
  } catch {
    return '';
  }
}

function captureContextRows(
  evidence: SurfaceEvidenceCardV1,
  copy: SurfaceExecutionTranslationsV1,
): Array<{ label: string; value: string }> {
  const context = evidence.captureContext;
  if (!context) return [];
  const target = context.target;
  const source = target.kind === 'browser'
    ? safeSourceUrl(context.sourceUrl || target.origin)
    : [
        safeSurfaceText(target.appName, '', 60),
        safeSurfaceText(target.title, '', 100),
      ].filter(Boolean).join(' · ');
  const rows = source ? [{ label: copy.evidence.captureSource, value: source }] : [];
  if (context.viewport) {
    const scale = context.viewport.deviceScaleFactor
      ? ` @${context.viewport.deviceScaleFactor}x`
      : '';
    rows.push({
      label: copy.evidence.captureViewport,
      value: `${context.viewport.width}×${context.viewport.height}${scale}`,
    });
  }
  return rows;
}

function useEvidencePreview(
  evidence: SurfaceEvidenceCardV1,
  scope: SurfaceEvidenceCardProps['scope'],
): EvidencePreviewState {
  const [state, setState] = useState<EvidencePreviewState>({ status: 'idle' });
  const assetRef = evidence.assetRef;

  useEffect(() => {
    let current = true;
    if (evidence.kind !== 'screenshot'
      || evidence.redactionStatus !== 'clean'
      || evidence.inspection.captureState !== 'captured'
      || !assetRef) {
      setState({ status: 'idle' });
      return () => { current = false; };
    }
    if (SAFE_DATA_IMAGE.test(assetRef)) {
      setState({ status: 'ready', dataUrl: assetRef });
      return () => { current = false; };
    }
    if (!OPAQUE_FRAME_REF.test(assetRef) || !scope) {
      setState({ status: 'unavailable' });
      return () => { current = false; };
    }
    setState({ status: 'loading' });
    void getSurfaceExecutionFrame({
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
      assetRef,
    }).then((frame) => {
      if (!current || !SAFE_DATA_IMAGE.test(frame.dataUrl)) return;
      setState({
        status: 'ready',
        dataUrl: frame.dataUrl,
        ...(frame.width ? { width: frame.width } : {}),
        ...(frame.height ? { height: frame.height } : {}),
      });
    }).catch(() => {
      if (current) setState({ status: 'unavailable' });
    });
    return () => { current = false; };
  }, [assetRef, evidence.inspection.captureState, evidence.kind, evidence.redactionStatus, scope]);

  return state;
}

export function SurfaceEvidenceCard({ evidence, copy, language, scope }: SurfaceEvidenceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = useEvidencePreview(evidence, scope);
  const contextRows = useMemo(() => captureContextRows(evidence, copy), [copy, evidence]);
  const inspected = hasVerifiedInspection(evidence);
  const analysisState = evidence.inspection.analysisState === 'analyzed' && !inspected
    ? 'incomplete'
    : evidence.inspection.analysisState;
  const analysisLabel = analysisState === 'incomplete'
    ? copy.evidence.analysisIncomplete
    : copy.evidence.analysisState[evidence.inspection.analysisState];
  const title = safeSurfaceText(evidence.title, copy.fallback.evidence, 140);
  const summary = safeSurfaceText(evidence.summary, '', 220);

  return (
    <article
      data-testid="surface-evidence-card"
      data-kind={evidence.kind}
      className="rounded-lg border border-white/[0.06] bg-white/[0.015] p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[9px] font-medium text-sky-200">
              {copy.evidence.kind[evidence.kind]}
            </span>
            <span className="text-[9px] text-zinc-600">{copy.evidence.source[evidence.source]}</span>
          </div>
          <h5 className="mt-1.5 text-xs font-medium text-zinc-300">{title}</h5>
          {summary && <p className="mt-1 text-[10px] leading-4 text-zinc-500">{summary}</p>}
        </div>
        <span className="shrink-0 text-[9px] text-zinc-600">
          {copy.evidence.redaction[evidence.redactionStatus]}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-zinc-600">
        <span>{formatSurfaceExecutionCopy(copy.evidence.capturedAt, {
          time: formatSurfaceTimestamp(evidence.capturedAt, language),
        })}</span>
        {evidence.assetRef && <span>{copy.evidence.assetReady}</span>}
      </div>

      {preview.status === 'loading' && (
        <div data-testid="surface-evidence-preview-loading" className="mt-2 text-[10px] text-zinc-600">
          {copy.evidence.previewLoading}
        </div>
      )}
      {preview.status === 'unavailable' && evidence.assetRef && (
        <div data-testid="surface-evidence-preview-unavailable" className="mt-2 text-[10px] text-zinc-600">
          {copy.evidence.previewUnavailable}
        </div>
      )}
      {preview.status === 'ready' && (
        <figure
          data-testid="surface-evidence-preview"
          data-expanded={expanded ? 'true' : 'false'}
          className="mt-2 overflow-hidden rounded-md border border-white/[0.06] bg-black/30"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto w-full cursor-zoom-in rounded-none bg-transparent p-0 hover:bg-transparent active:scale-100 [&>span]:block [&>span]:w-full"
            aria-label={expanded ? copy.evidence.previewCollapse : copy.evidence.previewExpand}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <img
              src={preview.dataUrl}
              alt={title}
              width={preview.width}
              height={preview.height}
              className={`w-full object-contain ${expanded ? 'max-h-[72vh]' : 'max-h-44'}`}
            />
          </Button>
          <figcaption className="border-t border-white/[0.05] px-2 py-1 text-[9px] text-zinc-600">
            {expanded ? copy.evidence.previewCollapse : copy.evidence.previewExpand}
          </figcaption>
        </figure>
      )}

      {contextRows.length > 0 && (
        <dl data-testid="surface-evidence-capture-context" className="mt-2 grid gap-1 rounded-md border border-white/[0.04] bg-black/10 px-2.5 py-2">
          {contextRows.map((row) => (
            <div key={row.label} className="flex min-w-0 items-start justify-between gap-3 text-[9px]">
              <dt className="shrink-0 text-zinc-600">{row.label}</dt>
              <dd className="min-w-0 truncate text-right text-zinc-400">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <dl className="mt-2 grid grid-cols-3 gap-2 rounded-md border border-white/[0.04] bg-black/10 px-2.5 py-2">
        <EvidenceAxis
          label={copy.evidence.capture}
          value={copy.evidence.captureState[evidence.inspection.captureState]}
          state={evidence.inspection.captureState}
        />
        <EvidenceAxis label={copy.evidence.analysis} value={analysisLabel} state={analysisState} />
        <EvidenceAxis
          label={copy.evidence.verification}
          value={copy.evidence.verificationState[evidence.inspection.verificationState]}
          state={evidence.inspection.verificationState}
        />
      </dl>

      <EvidenceChecklist evidence={evidence} copy={copy} language={language} />
    </article>
  );
}
