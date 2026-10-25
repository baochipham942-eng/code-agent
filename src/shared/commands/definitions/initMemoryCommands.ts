// /init-memory 不再注册 handler。GUI 面只留模式标记，禁止退回确定性扫描。

import type { CommandDefinition } from '../types';
import { INIT_MEMORY_GUI_DRAFT } from '../../../renderer/services/memoryGuiSurface';

if (INIT_MEMORY_GUI_DRAFT !== 'prompt-command') {
  throw new Error('init-memory gui surface mismatch');
}

export const initMemoryCommands: CommandDefinition[] = [];
