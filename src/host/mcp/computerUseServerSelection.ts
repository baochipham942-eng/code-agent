import type { MCPServerConfig } from './types';
import { CUA_DRIVER_SERVER_NAME } from './types';

export function pickEnabledComputerUseServers(
  defaults: MCPServerConfig[],
  alreadyRegistered: ReadonlySet<string>,
): MCPServerConfig[] {
  return defaults.filter(
    (server) =>
      (server.name === CUA_DRIVER_SERVER_NAME || server.name === 'argus')
      && server.enabled
      && !alreadyRegistered.has(server.name),
  );
}
