// ============================================================================
// builtin.videoGeneration — Step 5 第 2 个 builtin plugin（视频生成剥离）
//
// 与 host 同 bundle 编译/分发：video_generate 直接 import 宿主内部 API
// （configService / artifactMeta / MODEL_API_ENDPOINTS / DEFAULT_MODELS），
// 仅工具注册走 PluginAPI v2。
//
// 调用 `registerToolModule(module, { prefixWithPluginId: false })` 保留原工具名
// `video_generate`，避免破坏 executionPhase 分类、ToolSearch deferredTools、
// LLM prompt / cache / eval baseline。
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { videoGenerateModule } from './videoGenerate';

export const manifest: PluginManifest = {
  id: 'builtin.videoGeneration',
  name: 'Video Generation',
  version: '1.0.0',
  description: '视频生成（CogVideoX-2 异步任务 + GLM prompt 扩写）',
  author: 'code-agent',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['video-generation'],
  permissions: ['filesystem', 'network'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `video_generate`
  api.registerToolModule(videoGenerateModule, { prefixWithPluginId: false });
  api.log(
    'info',
    `builtin.videoGeneration activated (tool: ${videoGenerateModule.schema.name})`,
  );
}

const entry: PluginEntry = { activate };
export default entry;
