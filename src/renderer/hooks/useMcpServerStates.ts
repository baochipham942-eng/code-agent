import { useMcpStatus } from './useMcpStatus';

export type { MCPServerStateSummary } from './useMcpStatus';

export function useMcpServerStates() {
  return useMcpStatus().serverStates;
}
