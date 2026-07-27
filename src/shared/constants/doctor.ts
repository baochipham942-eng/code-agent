/**
 * Doctor 修复动作码。
 *
 * Host 只返回 machine-readable code；展示文案、路由与深链由前端解释。
 */
export const DOCTOR_FIX_CODES = {
  OPEN_RUNTIME_HELP: 'open-runtime-help',
  OPEN_DATA_DIRECTORY: 'open-data-directory',
  OPEN_PROVIDER_SETTINGS: 'open-provider-settings',
  OPEN_PROXY_HELP: 'open-proxy-help',
  OPEN_MCP_SETTINGS: 'open-mcp-settings',
  OPEN_BROWSER_RELAY_SETTINGS: 'open-browser-relay-settings',
  OPEN_HOOKS_SETTINGS: 'open-hooks-settings',
  OPEN_UPDATE_SETTINGS: 'open-update-settings',
} as const;

export type DoctorFixCode = (typeof DOCTOR_FIX_CODES)[keyof typeof DOCTOR_FIX_CODES];

export const DOCTOR_TIMEOUTS = {
  MIN_MS: 100,
  DEFAULT_PER_CHECK_MS: 10_000,
  DEFAULT_OVERALL_MS: 30_000,
  MAX_PER_CHECK_MS: 60_000,
  MAX_OVERALL_MS: 120_000,
} as const;
