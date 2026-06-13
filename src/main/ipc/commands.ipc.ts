// ============================================================================
// Prompt Command IPC Handlers - command:prompt:* 通道（roadmap 2.2）
// ============================================================================

import type { IpcMain } from '../platform';
import { COMMAND_CHANNELS } from '../../shared/ipc/channels';
import { getPromptCommandService } from '../services/commands/promptCommandService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CommandIPC');

function compactPreview(value: string | undefined, limit: number): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function registerPromptCommandHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    COMMAND_CHANNELS.PROMPT_LIST,
    async (_event, payload?: { workingDirectory?: string }) => {
      try {
        const workingDirectory = payload?.workingDirectory
          || process.env.CODE_AGENT_WORKING_DIR
          || process.cwd();
        const commands = await getPromptCommandService().listCommands(workingDirectory);
        // 只回序列化安全的展示字段；模板本体留在 main（展开发生在 sendMessage）
        return commands.map((command) => ({
          name: command.name,
          description: command.description,
          source: command.source,
          scope: command.scope,
          serverName: command.serverName,
          hints: command.hints,
          contentPreview: compactPreview(command.template, 180),
          contentSearchText: compactPreview(command.template, 1600),
        }));
      } catch (err) {
        logger.warn('PROMPT_LIST failed', { error: String(err) });
        return [];
      }
    },
  );
}
