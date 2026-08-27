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
    <div className="chat-col-pad mt-2 shrink-0">
      <div className="mx-auto max-h-[42vh] w-full max-w-3xl overflow-y-auto">
        <SurfaceExecutionConversationPanel
          conversationId={conversationId}
          projection={surfaceExecution.projection}
          onControl={surfaceExecution.onControl}
        />
      </div>
    </div>
  );
}
