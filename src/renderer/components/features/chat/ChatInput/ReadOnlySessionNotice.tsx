import React from 'react';
import { Button } from '../../../primitives/Button';
import { useI18n } from '../../../../hooks/useI18n';
import { useSessionStore } from '../../../../stores/sessionStore';

/** Replaces the composer text input when the current session is read-only. */
export function ReadOnlySessionNotice(): React.ReactElement {
  const { t } = useI18n();
  return (
    <div
      data-testid="readonly-session-notice"
      className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3"
    >
      <p className="text-sm text-zinc-300">{t.chatInput.readOnlyNotice}</p>
      <div className="mt-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          data-testid="readonly-session-new"
          onClick={() => {
            void useSessionStore.getState().createSession();
          }}
        >
          {t.chatInput.readOnlyNewSession}
        </Button>
      </div>
    </div>
  );
}
