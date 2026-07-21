import { useCallback } from 'react';
import type { SurfaceExecutionControlHandlerV1 } from '../components/features/surfaceExecution';
import { executeSurfaceExecutionControl } from '../services/surfaceExecutionController';
import { useSurfaceExecutionStore } from '../stores/surfaceExecutionStore';

export function useSurfaceExecutionConversation(conversationId: string | null) {
  const projection = useSurfaceExecutionStore((state) => (
    conversationId
      ? state.nativeByConversation[conversationId] ?? state.compatibilityByConversation[conversationId]
      : undefined
  ));
  const onControl = useCallback<SurfaceExecutionControlHandlerV1>(async (intent) => {
    if (!conversationId || intent.conversationId !== conversationId) {
      throw new Error('Surface control does not belong to the active conversation');
    }
    await executeSurfaceExecutionControl(intent);
  }, [conversationId]);

  return { projection, onControl };
}
