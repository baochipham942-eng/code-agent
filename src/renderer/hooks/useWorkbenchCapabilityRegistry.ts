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

// 返回的 mcpServers 是**全量**（buildWorkbenchCapabilityRegistry 的 withMissingMcpServers
// 会把 mcpServerStates 里没进「已连接 ∪ 手选」的也补齐，带 status + enabled）——
// 消费方要看 lazy / 被关掉的 server，直接用这份，别再单挂 useMcpServerStates。
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
