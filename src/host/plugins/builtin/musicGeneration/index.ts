// ============================================================================
// builtin.musicGeneration — 音乐生成内置插件（音乐最后一公里 Spec1 · U3）
//
// 与 host 同 bundle 编译/分发：music_generate 直接 import 宿主内部 API
// （configService / artifactMeta / musicGenerationService / musicCost），仅工具注册走 PluginAPI v2。
//
// 调用 `registerToolModule(module, { prefixWithPluginId: false })` 保留原工具名 `music_generate`，
// 避免破坏 executionPhase 分类、ToolSearch deferredTools、LLM prompt / cache / eval baseline。
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { musicGenerateModule } from './musicGenerate';

export const manifest: PluginManifest = {
  id: 'builtin.musicGeneration',
  name: 'Music Generation',
  version: '1.0.0',
  description: '音乐生成（MiniMax 内置 + provider:model 桥接，agent 对话产物入口）',
  author: 'Agent Neo',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['music-generation'],
  permissions: ['filesystem', 'network'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `music_generate`
  api.registerToolModule(musicGenerateModule, { prefixWithPluginId: false });
  api.log(
    'info',
    `builtin.musicGeneration activated (tool: ${musicGenerateModule.schema.name})`,
  );
}

const entry: PluginEntry = { activate };
export default entry;
