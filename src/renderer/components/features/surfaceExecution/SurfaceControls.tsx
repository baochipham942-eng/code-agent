import React, { useState } from 'react';
import type { SurfaceSessionControlActionV1 } from '@shared/contract/surfaceExecution';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { Button, type ButtonVariant } from '../../primitives';
import type { SurfaceExecutionControlHandlerV1 } from './types';
import { surfaceControlActions } from './surfaceExecutionPresentation';

interface SurfaceControlsProps {
  session: RendererSurfaceSessionProjectionV1;
  copy: SurfaceExecutionTranslationsV1;
  onControl?: SurfaceExecutionControlHandlerV1;
}

function controlVariant(action: SurfaceSessionControlActionV1): ButtonVariant {
  if (action === 'stop' || action === 'end_session') {
    return 'danger';
  }
  if (action === 'takeover') {
    return 'secondary';
  }
  return 'ghost';
}

export function SurfaceControls({ session, copy, onControl }: SurfaceControlsProps) {
  const [pending, setPending] = useState<SurfaceSessionControlActionV1 | null>(null);
  const [failed, setFailed] = useState(false);
  const actions = surfaceControlActions(session);
  const readonly = actions.length === 0 && (session.source === 'compat' || !session.writable);

  const requestControl = async (action: SurfaceSessionControlActionV1) => {
    if (!onControl || pending) return;
    setPending(action);
    setFailed(false);
    try {
      await onControl({
        version: 1,
        conversationId: session.scope.conversationId,
        surfaceSessionId: session.scope.surfaceSessionId,
        action,
      });
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      data-testid="surface-controls"
      data-readonly={readonly ? 'true' : 'false'}
      className="border-t border-white/[0.06] px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[11px] font-medium text-zinc-300">{copy.controls.label}</h4>
        {readonly && <span className="text-[10px] text-zinc-600">{copy.controls.readonly}</span>}
      </div>

      {!readonly && actions.length > 0 && onControl ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={controlVariant(action)}
              size="sm"
              title={copy.controls.hint[action]}
              aria-label={`${copy.controls.action[action]}: ${copy.controls.hint[action]}`}
              disabled={pending !== null}
              onClick={() => { void requestControl(action); }}
              className="text-[11px]"
            >
              {pending === action ? copy.controls.pending : copy.controls.action[action]}
            </Button>
          ))}
        </div>
      ) : !readonly ? (
        <p className="mt-2 text-[10px] text-zinc-600">{copy.controls.unavailable}</p>
      ) : null}

      {failed && <p role="status" className="mt-2 text-[10px] text-red-300">{copy.controls.failed}</p>}
    </section>
  );
}
