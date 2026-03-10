import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSandboxPath } from '../security/sandbox';
import type { ToolDefinition } from '../types';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.yml', '.yaml', '.sh', '.cjs', '.mjs']);

export const fileReadTool: ToolDefinition = {
  name: 'file_read',
  permissionLevel: 'L1_READ',
  description: 'Read a file from the local filesystem. Binary files are returned as base64.',
  async run(params, context) {
    const filePath = resolveSandboxPath(
      String(params.path ?? ''),
      context.config.workingDirectories,
      String(params.cwd ?? context.config.workingDirectories[0])
    );
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const requestedEncoding = String(params.encoding ?? '');
    const offset = Math.max(0, Number(params.offset ?? 0));
    const limit = Number(params.limit ?? 0);

    if (requestedEncoding === 'base64' || (!TEXT_EXTENSIONS.has(ext) && buffer.includes(0))) {
      return JSON.stringify(
        {
          path: filePath,
          encoding: 'base64',
          content: buffer.toString('base64'),
        },
        null,
        2
      );
    }

    const rawText = buffer.toString('utf8');
    const lines = rawText.split(/\r?\n/);
    const end = limit > 0 ? Math.min(lines.length, offset + limit) : lines.length;
    const sliced = offset > 0 || limit > 0 ? lines.slice(offset, end).join('\n') : rawText;

    return JSON.stringify(
      {
        path: filePath,
        encoding: 'utf8',
        content: sliced,
        totalLines: lines.length,
        offset,
        limit: limit > 0 ? limit : null,
      },
      null,
      2
    );
  },
};
