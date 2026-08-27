import { isHostReasonPayload, type HostReasonPayload, type HostReasonValue } from '@shared/contract';
import type { Translations } from '../i18n';
import { humanizeToolStep } from './humanizeToolStep';

export interface HostReasonCopy {
  summary: string;
  detail?: string;
  structured: boolean;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

function sanitizeMetadataValue(key: string, value: unknown, t: Translations): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  // eslint-disable-next-line no-control-regex -- Host metadata must not inject control characters into UI copy.
  const cleaned = String(value).split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return null;
  if (key === 'toolName') return humanizeToolStep(cleaned, undefined, t);
  if (key.toLowerCase().includes('path')) return basename(cleaned);
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

function interpolate(template: string, payload: HostReasonPayload, t: Translations): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (placeholder, key: string) => {
    const value = payload.metadata?.[key];
    return sanitizeMetadataValue(key, value, t) ?? placeholder;
  });
}

/**
 * 新载荷只查 renderer 登记表，绝不读取 modelText。string 是兼容一版的旧载荷，
 * 仍按旧路径原样返回，保证升级过程中不崩、不空白。
 */
export function resolveHostReasonCopy(
  reason: HostReasonValue | null | undefined,
  t: Translations,
): HostReasonCopy | null {
  if (typeof reason === 'string') {
    const legacy = reason.trim();
    return legacy ? { summary: legacy, structured: false } : null;
  }
  if (!isHostReasonPayload(reason)) return null;
  const copy: { summary: string; detail?: string } = t.agentError.hostReasons[reason.code];
  return {
    summary: interpolate(copy.summary, reason, t),
    detail: copy.detail ? interpolate(copy.detail, reason, t) : undefined,
    structured: true,
  };
}

export function readHostReasonFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): HostReasonValue | null {
  if (!metadata || typeof metadata !== 'object' || !('hostReason' in metadata)) return null;
  const value = metadata.hostReason;
  return typeof value === 'string' || isHostReasonPayload(value) ? value : null;
}
