// ============================================================================
// LSP / SkillWatcher workspace services（从 agentOrchestrator.ts 逐字搬出，
// N-MAXLINES-MINEFIELD-2-FU1-S2）。async、非阻塞，调用方自行串链排空。
// ============================================================================

import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentOrchestrator');

export function initializeLSP(workspaceRoot: string, workspaceFolders: string[] = [workspaceRoot]): Promise<void> {
  return import('../../lsp').then(async ({ initializeLSPManager, getLSPManager }) => {
    try {
      const existingManager = getLSPManager();
      if (existingManager) {
        logger.debug('LSP manager already exists, reinitializing for new workspace');
      }
      await initializeLSPManager(workspaceRoot, workspaceFolders);
      logger.info('LSP initialized for workspace:', workspaceRoot);
    } catch (error) {
      logger.warn('LSP initialization failed (non-blocking)', { error });
    }
  }).catch((error: unknown) => logger.warn('Failed to import LSP module', { error }));
}

export function updateSkillWatcher(workingDirectory: string): Promise<void> {
  return import('../../services/skills').then(async ({ getSkillWatcher }) => {
    try {
      const watcher = getSkillWatcher();
      if (watcher.isInitialized()) {
        await watcher.updateProjectDirectory(workingDirectory);
        logger.debug('SkillWatcher updated for workspace:', workingDirectory);
      }
    } catch (error) {
      logger.warn('SkillWatcher update failed (non-blocking)', { error });
    }
  }).catch((error: unknown) => logger.warn('Failed to import skills module', { error }));
}
