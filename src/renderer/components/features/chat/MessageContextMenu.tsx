import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useI18n } from '../../../hooks/useI18n';
import { Badge, Button, IconButton } from '../../primitives';
import {
  messageContextStatus,
  useMessageContextInterventions,
} from './useMessageContextInterventions';

interface MenuProps {
  sessionId?: string;
  messageId: string;
  /** Hide the control while this turn is still streaming. */
  streaming?: boolean;
  placement?: 'user' | 'reply';
}

export const MessageContextMenu: React.FC<MenuProps> = ({
  sessionId,
  messageId,
  streaming = false,
  placement = 'reply',
}) => {
  const { t } = useI18n();
  const sessionBusy = useAppStore((state) => (
    sessionId ? state.processingSessionIds.has(sessionId) : false
  ));
  const { snapshot, setAction } = useMessageContextInterventions(sessionId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const status = messageContextStatus(snapshot, messageId);
  const copy = t.messageKeepHide;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!sessionId || !messageId || streaming || sessionBusy) return null;

  const toggle = (action: 'pin' | 'exclude') => {
    const enabled = status !== action;
    void setAction(messageId, action, enabled).then(() => setOpen(false)).catch(() => undefined);
  };

  return (
    <div
      ref={rootRef}
      className={`relative ${placement === 'user' && !open ? 'mt-1 opacity-0 transition-opacity group-hover/user-prompt:opacity-100 focus-within:opacity-100' : ''}`}
    >
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        icon={<MoreHorizontal />}
        aria-label={copy.menuLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="message-context-menu-button"
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        <div
          role="menu"
          data-testid="message-context-menu"
          className="absolute right-0 z-30 mt-1 flex w-56 flex-col gap-0.5 rounded-md border border-border-muted bg-zinc-900 p-1 shadow-lg"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            role="menuitem"
            data-testid="message-context-pin"
            onClick={() => toggle('pin')}
          >
            {status === 'pin' ? copy.unpin : copy.pin}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            role="menuitem"
            data-testid="message-context-exclude"
            onClick={() => toggle('exclude')}
          >
            {status === 'exclude' ? copy.include : copy.exclude}
          </Button>
        </div>
      )}
    </div>
  );
};

export const MessageContextFrame: React.FC<{
  sessionId?: string;
  messageId: string;
  children: React.ReactNode;
}> = ({ sessionId, messageId, children }) => {
  const { t } = useI18n();
  const { snapshot } = useMessageContextInterventions(sessionId);
  const status = messageContextStatus(snapshot, messageId);
  if (!status) return <>{children}</>;
  const copy = t.messageKeepHide;
  const excluded = status === 'exclude';
  return (
    <div
      data-testid="message-context-frame"
      data-dimmed={excluded ? 'true' : 'false'}
      className={excluded ? 'min-w-0 opacity-60' : 'min-w-0'}
    >
      <Badge
        data-testid="message-context-badge"
        className="mb-1 border-border-muted bg-zinc-800/80 text-[10px] text-zinc-300"
      >
        {excluded ? copy.excludedBadge : copy.pinnedBadge}
      </Badge>
      {children}
    </div>
  );
};
