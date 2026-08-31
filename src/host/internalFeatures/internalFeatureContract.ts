import type { PluginManifest } from '../plugins/types';
import { INTERNAL_SDK_VERSION } from './internalSdkVersion';

export function assertInternalFeatureHostCompatibility(manifest: PluginManifest): void {
  const feature = manifest.internalFeature;
  if (manifest.surfaces?.[0] !== 'internal-feature' || !feature) return;
  if (feature.sdkVersion.host === INTERNAL_SDK_VERSION.host) return;

  const builtFor = feature.builtFrom?.appVersion
    ? `（插件构建于 Neo ${feature.builtFrom.appVersion}）`
    : '';
  throw new Error(`这个插件与当前应用的内部接口不匹配，请用当前版本重新构建${builtFor}`);
}
