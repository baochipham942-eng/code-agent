import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  ResearchDetectedData,
  ToolProgressData,
  ToolTimeoutData,
} from '@shared/contract';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { MessageUpdate } from '../useMessageBatcher';
import { useConversationStreamEffects } from './effects/useConversationStreamEffects';
import { usePermissionQueueEffects } from './effects/usePermissionQueueEffects';
import { useSessionLifecycleEffects } from './effects/useSessionLifecycleEffects';
import { useTaskProgressEffects } from './effects/useTaskProgressEffects';
import { useToolExecutionEffects } from './effects/useToolExecutionEffects';

type AppStoreState = ReturnType<typeof useAppStore.getState>;
type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

export interface AgentEffectsProps {
  addMessage: SessionStoreState['addMessage'];
  currentSessionId: string | null;
  currentTurnMessageIdRef: MutableRefObject<string | null>;
  enqueuePermissionRequest: AppStoreState['enqueuePermissionRequest'];
  flushRef: MutableRefObject<() => void>;
  lastEventAtRef: MutableRefObject<number>;
  pendingPermissionRequest: AppStoreState['pendingPermissionRequest'];
  pendingPermissionSessionId: AppStoreState['pendingPermissionSessionId'];
  queueUpdate: (update: MessageUpdate) => void;
  setActiveToolProgress: Dispatch<SetStateAction<ToolProgressData | null>>;
  setIsInterrupting: Dispatch<SetStateAction<boolean>>;
  setIsProcessing: AppStoreState['setIsProcessing'];
  setPendingPermissionRequest: AppStoreState['setPendingPermissionRequest'];
  setResearchDetected: Dispatch<SetStateAction<ResearchDetectedData | null>>;
  setSessionTaskComplete: AppStoreState['setSessionTaskComplete'];
  setSessionTaskProgress: AppStoreState['setSessionTaskProgress'];
  setTodos: SessionStoreState['setTodos'];
  setToolTimeoutWarning: Dispatch<SetStateAction<ToolTimeoutData | null>>;
  shiftQueuedPermissionRequest: AppStoreState['shiftQueuedPermissionRequest'];
  updateMessage: SessionStoreState['updateMessage'];
}

export const useAgentEffects = (props: AgentEffectsProps) => {
  useConversationStreamEffects(props);
  useToolExecutionEffects(props);
  usePermissionQueueEffects(props);
  useTaskProgressEffects(props);
  useSessionLifecycleEffects(props);
};
