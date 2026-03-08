// ============================================================================
// Soul IPC Handlers
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { loadSoul, getSoul } from '../prompts/soulLoader';
import { getUserConfigDir, getProjectConfigDir } from '../config/configPaths';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SoulIPC');

export function registerSoulHandlers(): void {
  ipcMain.handle(IPC_DOMAINS.SOUL, async (_event, request: IPCRequest) => {
    const { action, payload } = request;
    try {
      switch (action) {
        case 'getStatus': {
          const soul = getSoul();
          const workingDirectory = (payload as any)?.workingDirectory as string | undefined;
          let source: 'project' | 'user' | 'builtin' = 'builtin';
          if (workingDirectory) {
            const profilePath = path.join(getProjectConfigDir(workingDirectory), 'PROFILE.md');
            if (fs.existsSync(profilePath)) source = 'project';
          }
          if (source === 'builtin') {
            const soulPath = path.join(getUserConfigDir(), 'SOUL.md');
            if (fs.existsSync(soulPath)) source = 'user';
          }
          return { success: true, data: { source, length: soul.length } } satisfies IPCResponse;
        }
        case 'getProfile': {
          const { scope, workingDirectory: wd } = (payload || {}) as { scope: 'project' | 'user'; workingDirectory?: string };
          let filePath: string;
          if (scope === 'project' && wd) {
            filePath = path.join(getProjectConfigDir(wd), 'PROFILE.md');
          } else {
            filePath = path.join(getUserConfigDir(), 'SOUL.md');
          }
          const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
          return { success: true, data: { content, filePath } } satisfies IPCResponse;
        }
        case 'saveProfile': {
          const { scope, content, workingDirectory: wd } = (payload || {}) as { scope: 'project' | 'user'; content: string; workingDirectory?: string };
          let filePath: string;
          if (scope === 'project' && wd) {
            const dir = getProjectConfigDir(wd);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            filePath = path.join(dir, 'PROFILE.md');
          } else {
            const dir = getUserConfigDir();
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            filePath = path.join(dir, 'SOUL.md');
          }
          fs.writeFileSync(filePath, content, 'utf-8');
          loadSoul(wd);
          return { success: true, data: { filePath } } satisfies IPCResponse;
        }
        default:
          return { success: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown soul action: ${action}` } } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Soul IPC error:', error);
      return { success: false, error: { code: 'SOUL_ERROR', message: error instanceof Error ? error.message : 'Unknown error' } } satisfies IPCResponse;
    }
  });
}
