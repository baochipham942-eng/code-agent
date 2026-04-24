// useAgentState owns local refs and UI-only state for the agent hook.
import { useRef, useState } from 'react';
import type { ResearchDetectedData, ToolProgressData, ToolTimeoutData } from '@shared/contract';

export function useAgentState() {
  const currentTurnMessageIdRef = useRef<string | null>(null);
  const lastEventAtRef = useRef(Date.now());

  const [activeToolProgress, setActiveToolProgress] = useState<ToolProgressData | null>(null);
  const [toolTimeoutWarning, setToolTimeoutWarning] = useState<ToolTimeoutData | null>(null);
  const [researchDetected, setResearchDetected] = useState<ResearchDetectedData | null>(null);
  const [isInterrupting, setIsInterrupting] = useState(false);

  return {
    currentTurnMessageIdRef,
    lastEventAtRef,
    activeToolProgress,
    setActiveToolProgress,
    toolTimeoutWarning,
    setToolTimeoutWarning,
    researchDetected,
    setResearchDetected,
    isInterrupting,
    setIsInterrupting,
  };
}
