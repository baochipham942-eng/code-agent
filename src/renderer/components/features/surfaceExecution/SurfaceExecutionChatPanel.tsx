import React from 'react';
import { useSurfaceExecutionConversation } from '../../../hooks/useSurfaceExecutionConversation';
import { SurfaceExecutionConversationPanel } from './SurfaceExecutionConversationPanel';

interface SurfaceExecutionChatPanelProps {
  conversationId: string | null;
}

export function SurfaceExecutionChatPanel({ conversationId }: SurfaceExecutionChatPanelProps) {
  const surfaceExecution = useSurfaceExecutionConversation(conversationId);
  if (!conversationId || !surfaceExecution.projection) return null;

  return (
    <div className="mx-4 mt-2 max-h-[42vh] shrink-0 overflow-y-auto">
      <SurfaceExecutionConversationPanel
        conversationId={conversationId}
        projection={surfaceExecution.projection}
        onControl={surfaceExecution.onControl}
      />
    </div>
  );
}
