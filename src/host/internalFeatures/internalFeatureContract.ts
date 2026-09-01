import type { PluginManifest } from '../plugins/types';
import { INTERNAL_SDK_VERSION } from './internalSdkVersion';

export function assertInternalFeatureHostCompatibility(manifest: PluginManifest): void {
  const feature = manifest.internalFeature;
  if (manifest.surfaces?.[0] !== 'internal-feature' || !feature) return;
  if (feature.sdkVersion.host !== INTERNAL_SDK_VERSION.host) {
    const builtFor = feature.builtFrom?.appVersion
      ? `（插件构建于 Neo ${feature.builtFrom.appVersion}）`
      : '';
    throw new Error(`这个插件与当前应用的内部接口不匹配，请用当前版本重新构建${builtFor}`);
  }
  if (feature.sdkVersion.renderer !== INTERNAL_SDK_VERSION.renderer) {
    throw new Error('这个插件的界面版本与当前应用不匹配，请重新安装');
  }
}

export function assertPluginUiRendererCompatibility(manifest: PluginManifest): void {
  const pluginUi = manifest.pluginUi;
  if (manifest.surfaces?.[0] !== 'ui' || !pluginUi) return;
  if (pluginUi.sdkVersion.renderer !== INTERNAL_SDK_VERSION.renderer) {
    throw new Error('这个插件的界面版本与当前应用不匹配，请重新安装');
  }
}
