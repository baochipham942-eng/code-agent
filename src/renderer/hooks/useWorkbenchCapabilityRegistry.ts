import { useEffect, useMemo } from 'react';
import { useComposerStore } from '../stores/composerStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSkillStore } from '../stores/skillStore';
import { useConnectorStatuses } from './useConnectorStatuses';
import { useMcpServerStates, type MCPServerStateSummary } from './useMcpServerStates';
import {
  buildWorkbenchCapabilityRegistry,
  type WorkbenchCapabilityRegistry,
} from '../utils/workbenchCapabilityRegistry';

// mcpServers 那列是过滤过的（已连接 ∪ 手选）；要看「装好了但 lazy / 被关掉」的全量
// 状态用这份原始 serverStates——从同一个 hook 实例透出来，免得消费方再挂一份
// useMcpStatus（两对 IPC + 两个 MCP 事件监听）
export type WorkbenchCapabilityRegistryWithStates = WorkbenchCapabilityRegistry & {
  mcpServerStates: MCPServerStateSummary[];
};

export function useWorkbenchCapabilityRegistry(): WorkbenchCapabilityRegistryWithStates {
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

  return useMemo(() => ({
    ...buildWorkbenchCapabilityRegistry({
      mountedSkills,
      availableSkills,
      selectedSkillIds,
      connectorStatuses,
      selectedConnectorIds,
      mcpServerStates,
      selectedMcpServerIds,
    }),
    mcpServerStates,
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
