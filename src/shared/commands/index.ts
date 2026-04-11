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

import { getCommandRegistry } from './commandRegistry';
import { sessionCommands } from './definitions/sessionCommands';
import { modelCommands } from './definitions/modelCommands';
import { contextCommands } from './definitions/contextCommands';
import { toolsCommands } from './definitions/toolsCommands';
import { systemCommands } from './definitions/systemCommands';
import { newCommands } from './definitions/newCommands';

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
  ];

  for (const def of allDefs) {
    registry.register(def);
  }

  initialized = true;
}
