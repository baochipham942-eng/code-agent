// ============================================================================
// builtin.computerUse — Step 6 第 2 个 builtin plugin（macOS 桌面控制剥离）
//
// 与 host 同 bundle 编译/分发：5 个工具（Computer / computer_use / screenshot /
// gui_agent / ocr_search）通过 plugin 注册到 ToolRegistry。前 4 个 delegate 给
// legacy 实现（src/main/tools/vision/<X>），ocr_search 自包含调用 macOS Vision
// Framework 的 vision-ocr binary。
//
// 调用 `registerToolModule(module, { prefixWithPluginId: false })` 保留原工具名，
// 避免破坏 executionPhase 分类、ToolSearch deferredTools、LLM prompt /
// cache / eval baseline。
//
// resultMeta.ts 留在 host（`src/main/tools/modules/vision/resultMeta.ts`），
// 多个 vision plugin 共享该 adapter；本插件 4 个 delegate 工具仍从 host 路径
// import resultMeta，不复制一份到 plugin 目录。
//
// `platforms: ['darwin']` 声明仅 macOS（依赖 AXUIElement / Vision Framework /
// CGWindowList）。`nativeDeps: ['vision-ocr']` 披露 ocr_search 依赖的 Swift
// 二进制（由 scripts/build-vision-ocr.sh 编译，tauri.conf.json resources 内置）。
//
// permissions 字段不包含 'accessibility'（PluginPermission 类型目前未定义此值）；
// AXUIElement 权限由用户在系统设置 → 隐私与安全 → 辅助功能授权，与 plugin manifest
// 解耦。后续如需在 manifest 层声明，再走 PluginPermission 类型扩展流程。
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { computerModule } from './computer';
import { computerUseModule } from './computerUse';
import { screenshotModule } from './screenshot';
import { guiAgentModule } from './guiAgent';
import { ocrSearchModule } from './ocrSearch';

export const manifest: PluginManifest = {
  id: 'builtin.computerUse',
  name: 'Computer Use',
  version: '1.0.0',
  description: 'macOS 桌面控制 + Vision OCR（AXUIElement / 截图）',
  author: 'Agent Neo',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['computer-use', 'ocr'],
  permissions: ['filesystem', 'shell'],
  platforms: ['darwin'],
  nativeDeps: ['vision-ocr'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // cua-driver 启用时，桌面控制统一走 cua（AX 树优先 + 后台不抢焦点）。
  // 旧的原生桌面控制工具（Computer / computer_use / gui_agent）此时**不注册**，
  // 否则模型会把两套引擎混用：旧 computer_use 后台 AX 失败会降级抢前台、且其
  // 截图验证走智谱视觉模型易 403。符合提案 §1.2「禁止两个 computer-use 引擎
  // 运行时互切」。cua 关闭时保留旧工具作回退。
  // screenshot / ocr_search 是通用视觉工具（非桌面控制冲突项），始终保留。
  const cuaEnabled = process.env.CODE_AGENT_ENABLE_CUA === '1';

  // opt-out 前缀：保留原工具名，与历史 prompt / cache / eval baseline 兼容
  if (!cuaEnabled) {
    api.registerToolModule(computerModule, { prefixWithPluginId: false });
    api.registerToolModule(computerUseModule, { prefixWithPluginId: false });
    api.registerToolModule(guiAgentModule, { prefixWithPluginId: false });
  }
  api.registerToolModule(screenshotModule, { prefixWithPluginId: false });
  api.registerToolModule(ocrSearchModule, { prefixWithPluginId: false });
  api.log(
    'info',
    cuaEnabled
      ? `builtin.computerUse activated (cua mode: 仅 ${screenshotModule.schema.name} / ${ocrSearchModule.schema.name}，桌面控制让位 cua-driver)`
      : `builtin.computerUse activated (tools: ${computerModule.schema.name}, ${computerUseModule.schema.name}, ${screenshotModule.schema.name}, ${guiAgentModule.schema.name}, ${ocrSearchModule.schema.name})`,
  );
}

const entry: PluginEntry = { activate };
export default entry;
