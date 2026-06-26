// ============================================================================
// builtin.imageProcess — 首个 builtin plugin（P2 剥离首发流程验证）
//
// 与第三方插件的区别：
// - 与 host 同 bundle 编译/分发，import 内部 API（sharp / artifact / fileSize）
//   无需经过 PluginAPI，仅工具注册走 PluginAPI v2
// - 调用 `registerToolModule(module, { prefixWithPluginId: false })` 保留原工具名
//   `image_process`，避免破坏 executionPhase 分类、ToolSearch deferredTools、
//   LLM prompt / cache / eval baseline
// - 通过 `pluginRegistry.loadBuiltinPlugins()` 硬编码注册，不走磁盘 discovery
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { imageProcessModule } from './imageProcess';

export const manifest: PluginManifest = {
  id: 'builtin.imageProcess',
  name: 'Image Process',
  version: '1.0.0',
  description: '图片处理工具（格式转换/压缩/缩放/放大）',
  author: 'Agent Neo',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['image-processing'],
  permissions: ['filesystem'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `image_process`，避免破坏外部观察行为。
  // 详见 PluginAPI.registerToolModule 的 JSDoc。
  api.registerToolModule(imageProcessModule, { prefixWithPluginId: false });
  api.log('info', `builtin.imageProcess activated (tool name: ${imageProcessModule.schema.name})`);
}

const entry: PluginEntry = { activate };
export default entry;
