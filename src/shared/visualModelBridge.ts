import type { AppSettings, ModelCapability } from './contract';
import {
  buildProviderInfoFromSettings, getProviderRuntimeModels,
  isRuntimeProviderConfigured, mediaTypeForGenCapability,
} from './modelRuntime';

export type BridgedMediaType = 'image' | 'video' | 'music';

export interface BridgedVisualModel {
  /** `${providerId}:${modelId}` 命名空间，防撞内置/custom。 */
  id: string;
  label: string;
  mediaType: BridgedMediaType;
  sourceProvider: string;
  /** 发给端点的 model 参数。 */
  modelName: string;
  /** provider 显示名，作"来自 X"徽标。 */
  sourceLabel: string;
}

const GEN_CAPS: ModelCapability[] = ['imageGen', 'videoGen', 'musicGen'];

/** 纯函数：从已配置聊天 provider 派生带生成能力的视觉模型条目（不读 key，不发 IPC）。 */
export function deriveBridgedVisualModels(settings: AppSettings | null | undefined): BridgedVisualModel[] {
  const providers = settings?.models?.providers ?? {};
  const out: BridgedVisualModel[] = [];
  const seen = new Set<string>();

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!providerConfig || providerConfig.enabled === false) continue;
    if (!isRuntimeProviderConfigured(providerId, providerConfig)) continue;

    const info = buildProviderInfoFromSettings(providerId, providerConfig);
    const runtimeModels = getProviderRuntimeModels(info, providerConfig);
    const sourceLabel = providerConfig.displayName || providerId;

    for (const model of runtimeModels) {
      const genCap = model.capabilities.find((c) => GEN_CAPS.includes(c));
      if (!genCap) continue;
      const mediaType = mediaTypeForGenCapability(genCap);
      if (!mediaType) continue;
      const id = `${providerId}:${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: model.label || model.id, mediaType, sourceProvider: providerId, modelName: model.id, sourceLabel });
    }
  }
  return out;
}

/** 解析 `provider:model` 派生 id。非派生 id 返回 null。 */
export function parseBridgedId(id: string): { sourceProvider: string; modelName: string } | null {
  const idx = id.indexOf(':');
  if (idx <= 0) return null;
  return { sourceProvider: id.slice(0, idx), modelName: id.slice(idx + 1) };
}
