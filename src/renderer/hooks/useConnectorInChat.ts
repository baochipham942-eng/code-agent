import { useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';

export interface ConnectorInChatCapability {
  kind: 'connector' | 'mcp';
  id: string;
}

/**
 * Open a fresh chat, select exactly one connected capability in that chat's
 * composer scope, then hand focus to the composer without seeding any text.
 */
export function useConnectorInChat(): (capability: ConnectorInChatCapability) => Promise<void> {
  const createSession = useSessionStore((state) => state.createSession);
  const setSelectedConnectorIds = useComposerStore((state) => state.setSelectedConnectorIds);
  const setSelectedMcpServerIds = useComposerStore((state) => state.setSelectedMcpServerIds);
  const requestComposerFocus = useAppStore((state) => state.requestComposerFocus);

  return useCallback(async (capability: ConnectorInChatCapability) => {
    const session = await createSession('新对话', { workingDirectory: null });
    if (!session) return;

    if (capability.kind === 'connector') {
      setSelectedConnectorIds([capability.id]);
    } else {
      setSelectedMcpServerIds([capability.id]);
    }

    // createSession closes the capability hub and commits the chat surface on the
    // next paint. Emit the existing focus nonce after that mount boundary so the
    // ChatInput subscriber can hand focus to a live editor ref.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    requestComposerFocus();
  }, [
    createSession,
    requestComposerFocus,
    setSelectedConnectorIds,
    setSelectedMcpServerIds,
  ]);
}
