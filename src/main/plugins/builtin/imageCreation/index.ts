// ============================================================================
// builtin.imageCreation — Step 5 第 3 个 builtin plugin（图像生成/标注剥离）
//
// 与 host 同 bundle 编译/分发：image_generate + image_annotate 都直接 import
// 宿主内部 API（configService / authService / artifactMeta / imageGenerationService /
// MODEL_API_ENDPOINTS / ZHIPU_VISION_MODEL），仅工具注册走 PluginAPI v2。
//
// 调用 `registerToolModule(module, { prefixWithPluginId: false })` 保留原工具名
// `image_generate` / `image_annotate`，避免破坏 executionPhase 分类、ToolSearch
// deferredTools、LLM prompt / cache / eval baseline。
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { imageGenerateModule } from './imageGenerate';
import { imageAnnotateModule } from './imageAnnotate';

export const manifest: PluginManifest = {
  id: 'builtin.imageCreation',
  name: 'Image Creation',
  version: '1.0.0',
  description: 'AI 图片生成 + 图片标注（CogView-4 / FLUX.2 / 智谱视觉）',
  author: 'code-agent',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['image-generation', 'image-annotation'],
  permissions: ['filesystem', 'network'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `image_generate` / `image_annotate`
  api.registerToolModule(imageGenerateModule, { prefixWithPluginId: false });
  api.registerToolModule(imageAnnotateModule, { prefixWithPluginId: false });
  api.log(
    'info',
    `builtin.imageCreation activated (tools: ${imageGenerateModule.schema.name}, ${imageAnnotateModule.schema.name})`,
  );
}

const entry: PluginEntry = { activate };
export default entry;
