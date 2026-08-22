export const SHARE_SERVICE = {
  DEFAULT_BASE_URL: 'https://share.llmxy.xyz',
  MAX_BYTES: 26_214_400,
  TTL_PRESETS_SECONDS: [604_800, 2_592_000, 0] as const,
} as const;

export const SHARE_SERVICE_TIMEOUTS = {
  REQUEST_MS: 30_000,
} as const;
