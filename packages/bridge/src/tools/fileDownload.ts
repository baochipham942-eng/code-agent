import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSandboxPath } from '../security/sandbox';
import type { ToolDefinition } from '../types';

export const fileDownloadTool: ToolDefinition = {
  name: 'file_download',
  permissionLevel: 'L2_WRITE',
  description: 'Write base64 payload to a local file.',
  async run(params, context) {
    const filePath = resolveSandboxPath(String(params.path ?? ''), context.config.workingDirectories);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(String(params.base64 ?? ''), 'base64'));
    return JSON.stringify({ path: filePath, saved: true }, null, 2);
  },
};
