import React from 'react';
import { useI18n } from '../../../../hooks/useI18n';
import {
  selectIsCurrentComposerInProgress,
  useComposerNoticeStore,
  useRegisterComposerInProgress,
} from '../../../../stores/composerNoticeStore';

export const ComposerUploadStatus: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18n();
  useRegisterComposerInProgress('upload', active);
  const isCurrentInProgress = useComposerNoticeStore((state) => (
    selectIsCurrentComposerInProgress(state, 'upload')
  ));

  if (!active || !isCurrentInProgress) return null;

  return (
    <div
      data-testid="composer-upload-status"
      className="mb-2 flex items-center gap-2 rounded-lg border border-badge-warning/20 bg-amber-500/10 px-3 py-2"
    >
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-badge-warning border-t-transparent" />
      <span className="text-sm text-badge-warning">{t.chatInput.processingFiles}</span>
    </div>
  );
};

export default ComposerUploadStatus;
