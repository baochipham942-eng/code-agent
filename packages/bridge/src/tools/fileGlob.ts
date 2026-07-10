import { glob } from 'glob';
import { ensureSandboxDir, resolveSandboxPath } from '../security/sandbox';
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
    const rawMatches = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });
    const matches = rawMatches.flatMap((match) => {
      try {
        return [resolveSandboxPath(match, context.config.workingDirectories, cwd)];
      } catch {
        return [];
      }
    });
    return JSON.stringify({ cwd, pattern, matches }, null, 2);
  },
};
