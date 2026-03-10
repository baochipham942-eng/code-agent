import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSandboxPath } from '../security/sandbox';
import type { ToolDefinition } from '../types';

export const fileWriteTool: ToolDefinition = {
  name: 'file_write',
  permissionLevel: 'L2_WRITE',
  description: 'Write text or base64 content to a file.',
  async run(params, context) {
    const filePath = resolveSandboxPath(
      String(params.path ?? ''),
      context.config.workingDirectories,
      String(params.cwd ?? context.config.workingDirectories[0])
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const encoding = String(params.encoding ?? 'utf8');
    if (encoding === 'base64') {
      await fs.writeFile(filePath, Buffer.from(String(params.content ?? ''), 'base64'));
    } else {
      await fs.writeFile(filePath, String(params.content ?? ''), 'utf8');
    }
    return JSON.stringify({ path: filePath, written: true }, null, 2);
  },
};
