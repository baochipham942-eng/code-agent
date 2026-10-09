// ============================================================================
// Command Registry - Barrel Export
// ============================================================================

export * from './types';
export { CommandRegistry, getCommandRegistry } from './commandRegistry';

// Command definitions
export { sessionCommands } from './definitions/sessionCommands';
export { modelCommands } from './definitions/modelCommands';
export { contextCommands } from './definitions/contextCommands';
export { toolsCommands } from './definitions/toolsCommands';
export { systemCommands } from './definitions/systemCommands';
export { newCommands } from './definitions/newCommands';
export { doctorCommands } from './definitions/doctorCommands';
export { btwCommands } from './definitions/btwCommands';
// initMemoryCommands 不出 barrel：knip 视角无外部消费者（测试走 definitions 路径），
// 仅在下方 initializeCommands 内静态引用。

import { getCommandRegistry } from './commandRegistry';
import { sessionCommands } from './definitions/sessionCommands';
import { modelCommands } from './definitions/modelCommands';
import { contextCommands } from './definitions/contextCommands';
import { toolsCommands } from './definitions/toolsCommands';
import { systemCommands } from './definitions/systemCommands';
import { newCommands } from './definitions/newCommands';
import { doctorCommands } from './definitions/doctorCommands';
import { btwCommands } from './definitions/btwCommands';
import { initMemoryCommands } from './definitions/initMemoryCommands';

let initialized = false;

/**
 * 注册所有内置命令到 registry
 * 幂等：多次调用只注册一次
 */
export function initializeCommands(): void {
  if (initialized) return;

  const registry = getCommandRegistry();
  const allDefs = [
    ...sessionCommands,
    ...modelCommands,
    ...contextCommands,
    ...toolsCommands,
    ...systemCommands,
    ...newCommands,
    ...doctorCommands,
    ...btwCommands,
    ...initMemoryCommands,
  ];

  for (const def of allDefs) {
    registry.register(def);
  }

  initialized = true;
}
