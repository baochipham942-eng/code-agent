import type { AgentPointerNativeCursorCapability } from '../../shared/contract/desktop';
import { CUA_DRIVER_SERVER_NAME } from './types';

export const CUA_AGENT_CURSOR_TOOLS = new Set([
  'start_session',
  'end_session',
  'get_agent_cursor_state',
]);

export function buildCuaAgentCursorCapabilityForToolCall(args: {
  serverName?: string;
  toolName: string;
  success: boolean;
  error?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  checkedAtMs?: number;
}): AgentPointerNativeCursorCapability {
  const env = args.env || process.env;
  const platform = args.platform || process.platform;
  const checkedAtMs = args.checkedAtMs ?? Date.now();
  const supportedPlatform = platform === 'darwin' || platform === 'win32';
  const cuaEnabled = env.CODE_AGENT_ENABLE_CUA === '1';
  const isCuaServer = !args.serverName || args.serverName === CUA_DRIVER_SERVER_NAME;

  if (!supportedPlatform) {
    return {
      enabled: false,
      status: 'unavailable',
      provider: 'none',
      supportsSystemOverlay: false,
      reason: `unsupported_platform:${platform}`,
      fallbackSurface: 'renderer',
      checkedAtMs,
    };
  }

  if (!isCuaServer || !cuaEnabled) {
    return {
      enabled: false,
      status: 'fallback',
      provider: 'renderer',
      supportsSystemOverlay: false,
      reason: !isCuaServer ? 'not_cua_driver' : 'cua_disabled',
      fallbackSurface: 'renderer',
      checkedAtMs,
    };
  }

  if (!CUA_AGENT_CURSOR_TOOLS.has(args.toolName)) {
    return {
      enabled: false,
      status: 'fallback',
      provider: 'renderer',
      supportsSystemOverlay: false,
      reason: 'native_cursor_not_confirmed',
      fallbackSurface: 'renderer',
      checkedAtMs,
    };
  }

  if (!args.success) {
    return {
      enabled: false,
      status: 'fallback',
      provider: 'renderer',
      supportsSystemOverlay: false,
      reason: args.error ? `native_cursor_tool_failed:${args.error.slice(0, 120)}` : 'native_cursor_tool_failed',
      fallbackSurface: 'renderer',
      checkedAtMs,
    };
  }

  return {
    enabled: true,
    status: 'native',
    provider: 'cua-driver',
    supportsSystemOverlay: true,
    reason: `${args.toolName}_available`,
    fallbackSurface: null,
    checkedAtMs,
  };
}
