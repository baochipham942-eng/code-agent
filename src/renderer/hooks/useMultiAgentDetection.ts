// ============================================================================
// useMultiAgentDetection - Detect locally installed AI CLI tools
// ============================================================================

import { useState, useEffect, useCallback } from 'react';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface AgentInfo {
  id: string;
  name: string;
  command: string;
  version?: string;
  installed: boolean;
  description: string;
}

interface MultiAgentDetectionResult {
  agents: AgentInfo[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

// -----------------------------------------------------------------------------
// Known AI CLI Tools
// -----------------------------------------------------------------------------

const KNOWN_AGENTS: Omit<AgentInfo, 'installed' | 'version'>[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    description: 'Anthropic 官方 CLI 工具',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    command: 'gemini',
    description: 'Google Gemini 命令行工具',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    command: 'codex',
    description: 'OpenAI Codex CLI',
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    description: 'AI pair programming in terminal',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    command: 'cursor',
    description: 'Cursor AI 编辑器 CLI',
  },
];

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

/**
 * Hook to detect locally installed AI CLI tools.
 * Note: This is a placeholder implementation that returns static data.
 * Full implementation would require IPC calls to check command availability.
 */
export function useMultiAgentDetection(): MultiAgentDetectionResult {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const detectAgents = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // For now, return all known agents as not installed
      // Full implementation would check each command via IPC
      const detectedAgents: AgentInfo[] = KNOWN_AGENTS.map(agent => ({
        ...agent,
        installed: false,
        version: undefined,
      }));

      setAgents(detectedAgents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect agents');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    detectAgents();
  }, [detectAgents]);

  return {
    agents,
    isLoading,
    error,
    refresh: detectAgents,
  };
}

// -----------------------------------------------------------------------------
// Convenience Hooks
// -----------------------------------------------------------------------------

/**
 * Get only installed agents
 */
export function useInstalledAgents(): AgentInfo[] {
  const { agents } = useMultiAgentDetection();
  return agents.filter((agent) => agent.installed);
}

/**
 * Check if a specific agent is installed
 */
export function useIsAgentInstalled(agentId: string): boolean {
  const { agents } = useMultiAgentDetection();
  const agent = agents.find((a) => a.id === agentId);
  return agent?.installed ?? false;
}
