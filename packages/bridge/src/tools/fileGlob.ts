import { glob } from 'glob';
import { ensureSandboxDir } from '../security/sandbox';
import type { ToolDefinition } from '../types';

export const fileGlobTool: ToolDefinition = {
  name: 'file_glob',
  permissionLevel: 'L1_READ',
  description: 'Find files by glob pattern under an allowed working directory.',
  async run(params, context) {
    const cwd = await ensureSandboxDir(
      String(params.cwd ?? context.config.workingDirectories[0]),
      context.config.workingDirectories
    );
    const pattern = String(params.pattern ?? '**/*');
    const matches = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });
    return JSON.stringify({ cwd, pattern, matches }, null, 2);
  },
};
