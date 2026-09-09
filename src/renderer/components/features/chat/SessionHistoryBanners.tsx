import React from 'react';
import { ActiveConversationRewindBanner } from './ActiveConversationRewindBanner';
import { SessionLoadErrorBanner } from './SessionLoadErrorBanner';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';

export const SessionHistoryBanners: React.FC<{ sessionId: string | null; refreshToken: number; disabled: boolean }> = ({ sessionId, refreshToken, disabled }) => {
  const { t } = useI18n();
  const error = useSessionStore((state) => state.error);
  const setMessages = useSessionStore((state) => state.setMessages);
  if (error) return <SessionLoadErrorBanner key={sessionId} />;
  return <ActiveConversationRewindBanner sessionId={sessionId} refreshToken={refreshToken} disabled={disabled}
    onRestored={(result) => {
      setMessages(result.activeMessages);
      if (result.state === 'success' && result.failed.length === 0 && result.done.length === 0 && result.restoredMessageCount === 0) return;
      const restored = t.chat.rewindRestored.replace('{count}', String(result.restoredMessageCount));
      const message = `${restored} ${t.chat.turnCheckoutExternalEffects}`;
      if (result.state === 'success') toast.success(message);
      else toast.warning(`${t.chat.turnCheckoutNoteRedoPartial} ${message}`);
    }} />;
};
