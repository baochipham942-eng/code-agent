import type { AgentTaskResult, SharedContext } from './parallelAgentCoordinatorTypes';

export function createEmptySharedContext(): SharedContext {
  return {
    findings: new Map(),
    files: new Map(),
    decisions: new Map(),
    errors: [],
    lastUpdated: new Map(),
  };
}

export function formatSharedContextForPrompt(sharedContext: SharedContext): string {
  const parts: string[] = [];

  if (sharedContext.findings.size > 0) {
    parts.push('\n## Shared Discoveries from Other Agents:');
    for (const [key, value] of sharedContext.findings) {
      parts.push(`- [${key}]: ${value}`);
    }
  }

  if (sharedContext.files.size > 0) {
    parts.push('\n## Files Identified by Team:');
    for (const [path, agent] of sharedContext.files) {
      parts.push(`- ${path} (by ${agent})`);
    }
  }

  if (sharedContext.errors.length > 0) {
    parts.push('\n## Issues Encountered:');
    for (const error of sharedContext.errors) {
      parts.push(`- ${error}`);
    }
  }

  return parts.join('\n');
}

export function aggregateAgentTaskResults(results: AgentTaskResult[]): AgentTaskResult[] {
  return results.sort((a, b) => {
    if (a.success !== b.success) return a.success ? -1 : 1;
    const rolePriority: Record<string, number> = {
      architect: 5,
      coder: 4,
      reviewer: 3,
      tester: 2,
      debugger: 2,
      documenter: 1,
    };
    return (rolePriority[b.role] || 0) - (rolePriority[a.role] || 0);
  });
}
