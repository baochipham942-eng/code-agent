import os from 'node:os';
import type { ToolDefinition } from '../types';

export const systemInfoTool: ToolDefinition = {
  name: 'system_info',
  permissionLevel: 'L1_READ',
  description: 'Return host system information.',
  async run(_params, context) {
    return JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        release: os.release(),
        cpus: os.cpus().length,
        memory: { total: os.totalmem(), free: os.freemem() },
        uptime: os.uptime(),
        workingDirectories: context.config.workingDirectories,
      },
      null,
      2
    );
  },
};
