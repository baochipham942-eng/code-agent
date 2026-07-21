import React, { useEffect, useRef, useState } from 'react';
import type {
  SurfaceOutputPayloadV1,
  SurfaceOutputRefV1,
} from '@shared/contract/surfaceExecution';
import { redactSurfaceExecutionValue } from '@shared/utils/surfaceExecutionRedaction';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { getSurfaceExecutionOutput } from '../../../services/surfaceExecutionClient';
import type { SurfaceExecutionScopeV1 } from '../../../utils/surfaceExecutionProjection';
import { Button } from '../../primitives';
import { safeSurfaceText } from './surfaceExecutionPresentation';

interface SurfaceOutputEntryProps {
  output: SurfaceOutputRefV1;
  scope: Pick<SurfaceExecutionScopeV1, 'conversationId' | 'surfaceSessionId'>;
  copy: SurfaceExecutionTranslationsV1;
}

type OutputPreviewState =
  | { status: 'closed' | 'loading' | 'unavailable' }
  | { status: 'ready'; payload: SurfaceOutputPayloadV1 };

const OPAQUE_OUTPUT_REF = /^surface-output:\/\/[a-zA-Z0-9._:-]+$/;
const MAX_RENDERED_TEXT = 20_000;

function safeOutputText(payload: Extract<SurfaceOutputPayloadV1, { contentKind: 'text' }>): string {
  const redacted = redactSurfaceExecutionValue(payload.text);
  const value = typeof redacted === 'string' ? redacted : '';
  return value.length > MAX_RENDERED_TEXT ? `${value.slice(0, MAX_RENDERED_TEXT)}…` : value;
}

export function SurfaceOutputEntry({ output, scope, copy }: SurfaceOutputEntryProps) {
  const [state, setState] = useState<OutputPreviewState>({ status: 'closed' });
  const [expanded, setExpanded] = useState(false);
  const requestGeneration = useRef(0);
  const readable = OPAQUE_OUTPUT_REF.test(output.ref);
  const label = safeSurfaceText(output.label, copy.fallback.output, 120);

  useEffect(() => () => { requestGeneration.current += 1; }, []);

  const toggle = () => {
    if (!readable) return;
    if (state.status === 'ready') {
      setExpanded((value) => !value);
      return;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setState({ status: 'loading' });
    void getSurfaceExecutionOutput({
      version: 1,
      conversationId: scope.conversationId,
      surfaceSessionId: scope.surfaceSessionId,
      outputRef: output.ref,
    }).then((payload) => {
      if (requestGeneration.current !== generation) return;
      setState({ status: 'ready', payload });
      setExpanded(true);
    }).catch(() => {
      if (requestGeneration.current === generation) setState({ status: 'unavailable' });
    });
  };

  return (
    <li
      data-testid="surface-output-entry"
      data-readable={readable ? 'true' : 'false'}
      className="rounded-md border border-white/[0.04] bg-white/[0.01] px-2 py-1.5"
    >
      <div className="flex min-w-0 items-center justify-between gap-2 text-[10px]">
        <span className="min-w-0 truncate text-zinc-300">{label}</span>
        <span className="shrink-0 text-zinc-600">{copy.resources.outputKind[output.kind]}</span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!readable || state.status === 'loading'}
        aria-expanded={state.status === 'ready' ? expanded : false}
        className="mt-1 px-0 py-0 text-[9px] text-sky-300 hover:bg-transparent hover:text-sky-200 active:scale-100 disabled:text-zinc-600"
        onClick={toggle}
      >
        {!readable
          ? copy.resources.readonlyOutput
          : state.status === 'loading'
            ? copy.resources.loadingOutput
            : state.status === 'unavailable'
              ? copy.resources.unavailableOutput
              : state.status === 'ready' && expanded
                ? copy.resources.closeOutput
                : copy.resources.openOutput}
      </Button>
      {state.status === 'ready' && expanded && (
        <div data-testid="surface-output-preview" data-kind={state.payload.contentKind} className="mt-2">
          {state.payload.contentKind === 'image' ? (
            <img
              src={state.payload.dataUrl}
              alt={label}
              className="max-h-64 w-full rounded border border-white/[0.05] bg-black/30 object-contain"
            />
          ) : (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-white/[0.05] bg-black/30 p-2 text-[9px] leading-4 text-zinc-400">
              {safeOutputText(state.payload)}
            </pre>
          )}
          {state.payload.truncated && (
            <p className="mt-1 text-[9px] text-amber-300">{copy.resources.truncatedOutput}</p>
          )}
        </div>
      )}
    </li>
  );
}
