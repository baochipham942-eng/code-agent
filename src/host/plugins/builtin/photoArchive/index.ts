// ============================================================================
// builtin.photoArchive — Step 6 第 3 个 builtin plugin（相册归档剥离）
//
// 与 host 同 bundle 编译/分发：1 个工具（photo_archive）通过 plugin 注册到
// ToolRegistry。工具内部调用 host 侧的 `archiveAlbum` service，完成
// "Photos.app 导出 → vision-tagger 主题/人脸 → 聚类 → 入库 memories" 整条链路。
//
// 调用 `registerToolModule(module, { prefixWithPluginId: false })` 保留原工具名
// `photo_archive`，避免破坏 executionPhase 分类、ToolSearch deferredTools、
// LLM prompt / cache / eval baseline，以及 memories 表 `type='photo_archive'`
// 字面量与 builtinSkills 文档里的工具名引用。
//
// 留在 host 的依赖（plugin 通过 import 调用）：
// - src/host/services/desktop/photoLibraryTagger.ts — archiveAlbum 编排层
// - src/host/services/desktop/visionAnalysisService.ts — VLM HTTP 调用层
// - src/host/connectors/native/photos.ts — Photos.app osascript connector
// 这些 service 形态本身可被多处复用（不止本插件），不复制到 plugin 目录。
//
// `platforms: ['darwin']` 声明仅 macOS（依赖 Vision Framework + Photos.app +
// AppleScript）。`nativeDeps: ['vision-tagger']` 披露 Swift 二进制依赖
// （由 scripts/build-vision-tagger.sh 编译，tauri.conf.json resources 内置）。
//
// permissions：
// - 'filesystem' — 导出照片到临时目录、读写归档结果
// - 'shell' — 调用 photos connector 的 osascript 和 vision-tagger 子进程
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { photoArchiveModule } from './photoArchive';

export const manifest: PluginManifest = {
  id: 'builtin.photoArchive',
  name: 'Photo Archive',
  version: '1.0.0',
  description: 'macOS 相册归档（Photos.app + Vision 主题/人脸聚类）',
  author: 'Agent Neo',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['photo-archive', 'image-search'],
  permissions: ['filesystem', 'shell'],
  platforms: ['darwin'],
  nativeDeps: ['vision-tagger'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `photo_archive`，与历史 prompt / cache / eval
  // baseline、memories 表 type 字面量、builtinSkills 文档引用兼容。
  api.registerToolModule(photoArchiveModule, { prefixWithPluginId: false });
  api.log('info', `builtin.photoArchive activated (tool: ${photoArchiveModule.schema.name})`);
}

const entry: PluginEntry = { activate };
export default entry;
