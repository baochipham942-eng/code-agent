import React from 'react';
import { Button } from '../../../primitives/Button';
import { useI18n } from '../../../../hooks/useI18n';

/** One-line offer above the empty composer. Copy stays neutral about send outcome. */
export function UnsentDraftNotice({
  preview,
  onPutBack,
  onDiscard,
}: {
  preview: string;
  onPutBack: () => void;
  onDiscard: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  const message = t.chatInput.unsentDraftNotice.replace('{preview}', () => preview);
  return (
    <div
      data-testid="unsent-draft-notice"
      className="mb-2 flex items-center gap-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-2"
    >
      <p className="min-w-0 flex-1 truncate text-sm text-text-primary">{message}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="unsent-draft-put-back"
        onClick={onPutBack}
      >
        {t.chatInput.unsentDraftPutBack}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="unsent-draft-discard"
        onClick={onDiscard}
      >
        {t.chatInput.unsentDraftDiscard}
      </Button>
    </div>
  );
}
