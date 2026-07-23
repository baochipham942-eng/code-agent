import { useEffect, useMemo, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import {
  deriveSurfaceIntentTurnId,
  findNewCurrentTurnPreviewArtifacts,
} from '../utils/surfaceIntent';
import { openSurfaceForArtifact } from '../services/surfaceIntentDispatcher';
import { syncSurfaceIntentContext } from '../services/surfaceIntentRuntime';
import { useWorkspacePreviewModelState } from './useWorkspacePreviewModel';

/**
 * 观察现成的 workspace preview 派生模型。只对当前轮第一次出现的 item 发出产物意图；
 * 会话切换时把已有 item 当基线，避免历史产物在切回会话时抢焦点。
 */
export function useArtifactSurfaceIntent(): void {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const messages = useSessionStore((state) => state.messages);
  const { items, currentTurnArtifacts } = useWorkspacePreviewModelState();
  const turnId = useMemo(() => deriveSurfaceIntentTurnId(messages), [messages]);
  const observedContextRef = useRef<string | null>(null);
  const observedItemIdsRef = useRef(new Set<string>());

  useEffect(() => {
    syncSurfaceIntentContext({ currentSessionId, turnId });
  }, [currentSessionId, turnId]);

  useEffect(() => {
    const contextKey = `${currentSessionId ?? '<none>'}\u0000${turnId}`;
    const previousContext = observedContextRef.current;
    if (previousContext?.split('\u0000')[0] !== (currentSessionId ?? '<none>')) {
      observedContextRef.current = contextKey;
      observedItemIdsRef.current = findNewCurrentTurnPreviewArtifacts(
        items,
        currentTurnArtifacts?.turnNumber,
        new Set(),
      ).observedIds;
      return;
    }
    if (previousContext !== contextKey) {
      observedContextRef.current = contextKey;
      observedItemIdsRef.current = new Set();
    }

    const observed = findNewCurrentTurnPreviewArtifacts(
      items,
      currentTurnArtifacts?.turnNumber,
      observedItemIdsRef.current,
    );
    observedItemIdsRef.current = observed.observedIds;
    const { newItems } = observed;
    const firstNewItem = newItems[0];
    if (!firstNewItem) return;

    openSurfaceForArtifact({
      artifact: {
        kind: 'workspace-preview',
        itemId: firstNewItem.id,
      },
      artifactSessionId: currentSessionId ?? undefined,
    });
  }, [currentSessionId, currentTurnArtifacts?.turnNumber, items, turnId]);
}
