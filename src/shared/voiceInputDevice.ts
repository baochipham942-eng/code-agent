import type { VoiceInputDeviceSettings } from './contract/settings';

/**
 * 配置文件是长期存量边界，不能相信 TypeScript 静态类型。只接受非空 label；
 * webDeviceId 缺失或损坏时仍保留 label-only 配置，供两条采集链按名字解析。
 */
export function normalizeVoiceInputDevice(value: unknown): VoiceInputDeviceSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.label !== 'string') return undefined;
  const label = candidate.label.trim();
  if (!label) return undefined;

  const webDeviceId = typeof candidate.webDeviceId === 'string'
    ? candidate.webDeviceId.trim()
    : '';
  return webDeviceId ? { label, webDeviceId } : { label };
}
