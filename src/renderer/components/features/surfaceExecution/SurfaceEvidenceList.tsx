import React from 'react';
import type { SurfaceEvidenceCardV1 } from '@shared/contract/surfaceExecution';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import type { SurfaceExecutionScopeV1 } from '../../../utils/surfaceExecutionProjection';
import { SurfaceEvidenceCard } from './SurfaceEvidenceCard';

interface SurfaceEvidenceListProps {
  evidence: readonly SurfaceEvidenceCardV1[];
  copy: SurfaceExecutionTranslationsV1;
  language: 'zh' | 'en';
  scope?: Pick<SurfaceExecutionScopeV1, 'conversationId' | 'surfaceSessionId'>;
}

export function SurfaceEvidenceList({ evidence, copy, language, scope }: SurfaceEvidenceListProps) {
  return (
    <section
      data-testid="surface-evidence-list"
      data-persistence="conversation"
      className="border-t border-white/[0.06] px-4 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-medium text-zinc-300">{copy.resources.evidence}</h4>
        <span className="text-[10px] text-zinc-600">{evidence.length}</span>
      </div>
      {evidence.length === 0 ? (
        <p className="mt-2 text-[10px] text-zinc-600">{copy.evidence.empty}</p>
      ) : (
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {evidence.map((item) => (
            <SurfaceEvidenceCard
              key={item.evidenceId}
              evidence={item}
              copy={copy}
              language={language}
              scope={scope}
            />
          ))}
        </div>
      )}
    </section>
  );
}
