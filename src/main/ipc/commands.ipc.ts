// ============================================================================
// Prompt Command IPC Handlers - command:prompt:* 通道（roadmap 2.2）
// ============================================================================

import type { IpcMain } from '../platform';
import { COMMAND_CHANNELS } from '../../shared/ipc/channels';
import { getPromptCommandService } from '../services/commands/promptCommandService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CommandIPC');

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
          hints: command.hints,
        }));
      } catch (err) {
        logger.warn('PROMPT_LIST failed', { error: String(err) });
        return [];
      }
    },
  );
}
