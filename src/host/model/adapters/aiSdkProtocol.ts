// 自定义 provider 走 AI SDK 时的协议与 Anthropic baseURL。
// @ai-sdk/anthropic 把 /messages 直接拼在 baseURL 后面，不会自己补 /v1。
// 只有 claude 改道 Messages；responses 与其余值保持当前 OpenAI 兼容路径。

import type { ModelConfig, ModelProviderProtocol } from '../../../shared/contract';
import { resolveProviderProtocol } from '../../../shared/modelRuntime';
import { getConfigService } from '../../services/core/configService';

const ANTHROPIC_VERSION_SEGMENT = /^v\d+$/;

function readSettingsProtocol(provider: string): ModelProviderProtocol | undefined {
  try {
    return getConfigService().getSettings().models?.providers?.[provider]?.protocol;
  } catch {
    return undefined;
  }
}

/** config.protocol 优先，否则 settings，再否则 resolveProviderProtocol 的缺省。 */
export function resolveAdapterProtocol(config: ModelConfig): 'claude' | 'openai' {
  const declared = config.protocol ?? readSettingsProtocol(config.provider);
  if (declared === 'claude') return 'claude';
  if (declared) return 'openai';
  return resolveProviderProtocol(config.provider) === 'claude' ? 'claude' : 'openai';
}

function versionedPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (!ANTHROPIC_VERSION_SEGMENT.test(last)) segments.push('v1');
  return `/${segments.join('/')}`;
}

/** 去掉末尾斜杠；最后一段不是 /v<digits> 时补 /v1。host 与 query 保持不变。 */
export function normalizeAnthropicBaseUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = versionedPath(parsed.pathname);
    return parsed.toString();
  } catch {
    const queryAt = trimmed.indexOf('?');
    const hashAt = trimmed.indexOf('#');
    const cuts = [queryAt, hashAt].filter((index) => index >= 0);
    const cut = cuts.length > 0 ? Math.min(...cuts) : trimmed.length;
    const path = versionedPath(trimmed.slice(0, cut).replace(/\/+$/, '') || '/');
    return `${path}${trimmed.slice(cut)}`;
  }
}
