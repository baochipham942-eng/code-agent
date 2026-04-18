import { useMemo } from 'react';
import type { ToolCall } from '@shared/contract/tool';
import { useSessionStore } from '../stores/sessionStore';
import {
  buildWorkbenchHistory,
  buildWorkbenchReferences,
  extractWorkbenchInvocationSummary,
  useWorkbenchCapabilities,
  type WorkbenchCapabilities,
  type WorkbenchHistoryItem,
  type WorkbenchInvocationSummary,
  type WorkbenchReference,
} from './useWorkbenchCapabilities';

export interface WorkbenchInsights {
  capabilities: WorkbenchCapabilities;
  invocationSummary: WorkbenchInvocationSummary;
  references: WorkbenchReference[];
  history: WorkbenchHistoryItem[];
  connectorHistory: WorkbenchHistoryItem[];
  mcpHistory: WorkbenchHistoryItem[];
  skillHistory: WorkbenchHistoryItem[];
}

interface InsightMessage {
  timestamp: number;
  toolCalls?: ToolCall[];
}

export function buildWorkbenchInsights(args: {
  messages: InsightMessage[];
  capabilities: WorkbenchCapabilities;
}): WorkbenchInsights {
  const invocationSummary = extractWorkbenchInvocationSummary(args.messages);
  const references = buildWorkbenchReferences({
    skills: args.capabilities.skills,
    connectors: args.capabilities.connectors,
    mcpServers: args.capabilities.mcpServers,
    invocationSummary,
  });
  const history = buildWorkbenchHistory({
    messages: args.messages,
    skills: args.capabilities.skills,
    connectors: args.capabilities.connectors,
    mcpServers: args.capabilities.mcpServers,
  });

  return {
    capabilities: args.capabilities,
    invocationSummary,
    references,
    history,
    connectorHistory: history.filter((item) => item.kind === 'connector'),
    mcpHistory: history.filter((item) => item.kind === 'mcp'),
    skillHistory: history.filter((item) => item.kind === 'skill'),
  };
}

export function useWorkbenchInsights(): WorkbenchInsights {
  const messages = useSessionStore((state) => state.messages);
  const capabilities = useWorkbenchCapabilities();

  return useMemo(
    () => buildWorkbenchInsights({
      messages: messages.slice(-50),
      capabilities,
    }),
    [capabilities, messages],
  );
}
