import fs from 'node:fs/promises';
import { resolveSandboxPath } from '../security/sandbox';
import type { ToolDefinition } from '../types';

export const fileEditTool: ToolDefinition = {
  name: 'file_edit',
  permissionLevel: 'L2_WRITE',
  description: 'Perform string replacement inside a file.',
  async run(params, context) {
    const filePath = resolveSandboxPath(String(params.path ?? ''), context.config.workingDirectories);
    const oldString = String(params.old_string ?? '');
    const newString = String(params.new_string ?? '');
    const replaceAll = params.replace_all === true;
    const content = await fs.readFile(filePath, 'utf8');
    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      throw new Error('old_string not found');
    }
    if (!replaceAll && occurrences > 1) {
      throw new Error(`old_string matched ${occurrences} times; set replace_all=true to continue`);
    }

    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    await fs.writeFile(filePath, next, 'utf8');
    return JSON.stringify({ path: filePath, occurrences, replaceAll }, null, 2);
  },
};
