import { useEffect, useMemo } from 'react';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSkillStore } from '../stores/skillStore';
import { useConnectorStatuses } from './useConnectorStatuses';
import { useMcpServerStates } from './useMcpServerStates';
import {
  buildWorkbenchCapabilityRegistry,
  type WorkbenchCapabilityRegistry,
} from '../utils/workbenchCapabilityRegistry';

export function useWorkbenchCapabilityRegistry(): WorkbenchCapabilityRegistry {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const mountedSkills = useSkillStore((state) => state.mountedSkills);
  const availableSkills = useSkillStore((state) => state.availableSkills);
  const setSkillSession = useSkillStore((state) => state.setCurrentSession);
  const fetchAvailableSkills = useSkillStore((state) => state.fetchAvailableSkills);
  const selectedSkillIds = useComposerStore((state) => state.selectedSkillIds);
  const selectedConnectorIds = useComposerStore((state) => state.selectedConnectorIds);
  const selectedMcpServerIds = useComposerStore((state) => state.selectedMcpServerIds);
  const connectorStatuses = useConnectorStatuses();
  const mcpServerStates = useMcpServerStates();

  useEffect(() => {
    if (currentSessionId) {
      setSkillSession(currentSessionId);
    }
  }, [currentSessionId, setSkillSession]);

  useEffect(() => {
    if (availableSkills.length === 0) {
      void fetchAvailableSkills();
    }
  }, [availableSkills.length, fetchAvailableSkills]);

  return useMemo(() => buildWorkbenchCapabilityRegistry({
    mountedSkills,
    availableSkills,
    selectedSkillIds,
    connectorStatuses,
    selectedConnectorIds,
    mcpServerStates,
    selectedMcpServerIds,
  }), [
    availableSkills,
    connectorStatuses,
    mcpServerStates,
    mountedSkills,
    selectedConnectorIds,
    selectedMcpServerIds,
    selectedSkillIds,
  ]);
}
