import React, { lazy, Suspense } from 'react';
import { useI18n } from '../hooks/useI18n';
import type { DiffViewProps } from './DiffView.types';

const CodeMirrorDiffView = lazy(() => import('./CodeMirrorDiffView'));

export const DiffView: React.FC<DiffViewProps> = (props) => {
  const { t } = useI18n();

  return (
    <Suspense
      fallback={(
        <div
          className={`diff-view min-h-16 animate-pulse rounded-lg bg-[var(--bg-surface)] ${props.className ?? ''}`}
          data-diff-loading="true"
        />
      )}
    >
      <CodeMirrorDiffView {...props} labels={t.turnDiff.viewer} />
    </Suspense>
  );
};

export default DiffView;
export type { DiffViewProps } from './DiffView.types';
