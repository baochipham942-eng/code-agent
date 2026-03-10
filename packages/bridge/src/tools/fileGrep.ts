import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import { ensureSandboxDir } from '../security/sandbox';
import type { ToolDefinition } from '../types';

export const fileGrepTool: ToolDefinition = {
  name: 'file_grep',
  permissionLevel: 'L1_READ',
  description: 'Search file content by regular expression.',
  async run(params, context) {
    const cwd = await ensureSandboxDir(
      String(params.cwd ?? context.config.workingDirectories[0]),
      context.config.workingDirectories
    );
    const pattern = String(params.pattern ?? '');
    const include = String(params.include ?? '**/*');
    const caseSensitive = params.caseSensitive !== false;
    const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    const files = await glob(include, {
      cwd,
      absolute: true,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });

    const results: Array<{ path: string; line: number; text: string }> = [];
    for (const file of files.slice(0, 500)) {
      const content = await fs.readFile(file, 'utf8').catch(() => '');
      if (!content) {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        regex.lastIndex = 0;
        if (regex.test(lines[index])) {
          results.push({ path: path.resolve(file), line: index + 1, text: lines[index] });
        }
      }
    }

    return JSON.stringify({ cwd, pattern, include, matchCount: results.length, results }, null, 2);
  },
};
