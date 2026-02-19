// ============================================================================
// Agent Markdown Watcher - Hot-reload agent .md files on change
// ============================================================================

import { watch } from 'fs';
import { loadCustomAgents } from './coreAgents';

/**
 * Watch an agents directory for .md file changes and reload custom agents.
 * Returns a cleanup function to stop watching.
 */
export function watchAgentsMdDir(dir: string, workingDirectory?: string): () => void {
  const watcher = watch(dir, { recursive: true }, async (eventType, filename) => {
    if (filename?.endsWith('.md')) {
      await loadCustomAgents(workingDirectory);
    }
  });
  return () => watcher.close();
}
