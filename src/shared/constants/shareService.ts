export const SHARE_SERVICE = {
  DEFAULT_BASE_URL: 'https://share.llmxy.xyz:8443',
  MAX_BYTES: 26_214_400,
  TTL_PRESETS_SECONDS: [604_800, 2_592_000, 0] as const,
} as const;

/** 设置里存过已停用的 Sealos 地址按未配置处理。 */
export function resolveShareBaseUrl(configured: string | null | undefined): string {
  const trimmed = configured?.trim();
  const usable = trimmed && !trimmed.includes('.sealos.run') ? trimmed : SHARE_SERVICE.DEFAULT_BASE_URL;
  return usable.replace(/\/+$/, '');
}

export const SHARE_SERVICE_TIMEOUTS = {
  REQUEST_MS: 30_000,
} as const;
