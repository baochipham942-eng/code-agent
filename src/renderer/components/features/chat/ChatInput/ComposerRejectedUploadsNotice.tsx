import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives/Button';
import { useComposerRejectedUploadsStore } from '../../../../stores/composerRejectedUploadsStore';
import { formatFileSize } from './formatFileSize';

const MAX_VISIBLE_LINES = 3;

export const ComposerRejectedUploadsNotice: React.FC = () => {
  const { t } = useI18n();
  const items = useComposerRejectedUploadsStore((s) => s.items);
  const dismiss = useComposerRejectedUploadsStore((s) => s.dismiss);

  if (items.length === 0) return null;

  const visible = items.slice(0, MAX_VISIBLE_LINES);
  const overflow = items.length - visible.length;

  return (
    <div
      data-testid="composer-rejected-uploads"
      role="alert"
      className="mb-2 rounded-lg border border-badge-warning/20 bg-amber-500/10 px-3 py-2"
    >
      {visible.map((item) => (
        <div key={item.id} className="flex items-center gap-2" data-testid="composer-rejected-upload-row">
          <span className="min-w-0 flex-1 text-sm text-badge-warning">
            {t.chatInput.rejectedUploadRow
              .replace('{name}', item.name)
              .replace('{size}', formatFileSize(item.size))}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t.chatInput.rejectedUploadDismiss}
            data-testid="composer-rejected-upload-dismiss"
            onClick={() => dismiss(item.id)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {overflow > 0 && (
        <div className="text-sm text-badge-warning" data-testid="composer-rejected-uploads-more">
          {t.chatInput.rejectedUploadMore.replace('{count}', String(overflow))}
        </div>
      )}
    </div>
  );
};
