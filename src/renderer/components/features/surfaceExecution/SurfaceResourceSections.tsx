import React from 'react';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { surfaceSourceLabel } from './surfaceExecutionPresentation';
import { SurfaceOutputEntry } from './SurfaceOutputEntry';

interface SurfaceResourceSectionsProps {
  session: RendererSurfaceSessionProjectionV1;
  copy: SurfaceExecutionTranslationsV1;
}

export function SurfaceResourceSections({ session, copy }: SurfaceResourceSectionsProps) {
  const source = surfaceSourceLabel(session.session.activeTarget, copy);

  return (
    <div
      data-testid="surface-resources"
      data-persistence="conversation"
      className="grid gap-2 px-4 pb-3 sm:grid-cols-2"
    >
      <section className="rounded-lg border border-white/[0.06] bg-black/10 p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-medium text-zinc-300">{copy.resources.outputs}</h4>
          <span className="text-[10px] text-zinc-600">{session.outputs.length}</span>
        </div>
        {session.outputs.length === 0 ? (
          <p className="mt-2 text-[10px] text-zinc-600">{copy.resources.emptyOutputs}</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {session.outputs.map((output) => (
              <SurfaceOutputEntry
                key={output.ref}
                output={output}
                scope={session.scope}
                copy={copy}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-white/[0.06] bg-black/10 p-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-medium text-zinc-300">{copy.resources.sources}</h4>
          <span className="text-[9px] text-zinc-600">{copy.resources.readonlySource}</span>
        </div>
        <p className={`mt-2 text-[10px] ${source ? 'text-zinc-400' : 'text-zinc-600'}`}>
          {source || copy.resources.emptySources}
        </p>
      </section>
    </div>
  );
}
