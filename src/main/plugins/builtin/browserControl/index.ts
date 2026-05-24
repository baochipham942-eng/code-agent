// ============================================================================
// builtin.browserControl — Step 6 第 1 个 builtin plugin（浏览器控制剥离）
//
// 与 host 同 bundle 编译/分发：4 个工具（Browser / browser_action /
// browser_navigate / validate_html_in_app）都直接 import 宿主内部依赖
// （legacy BrowserTool / browserActionTool / browserNavigateTool /
// inAppValidationService），仅工具注册走 PluginAPI v2。
//
// 调用 `registerToolModule(module, { prefixWithPluginId: false })` 保留原工具名，
// 避免破坏 executionPhase 分类、ToolSearch deferredTools、LLM prompt /
// cache / eval baseline。
//
// resultMeta.ts 留在 host（`src/main/tools/modules/vision/resultMeta.ts`），
// 多个 vision plugin 共享该 adapter；本插件 3 个 browser 工具仍从 host
// 路径 import resultMeta，不复制一份到 plugin 目录。
//
// `platforms: ['darwin', 'win32', 'linux']` 声明跨平台支持（Playwright 走
// host bundle import，由 host 负责跨平台分发），不声明 nativeDeps。
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { browserModule } from './browser';
import { browserActionModule } from './browserAction';
import { browserNavigateModule } from './browserNavigate';
import { validateHtmlInAppModule } from './validateHtmlInApp';

export const manifest: PluginManifest = {
  id: 'builtin.browserControl',
  name: 'Browser Control',
  version: '1.0.0',
  description: '浏览器与 in-app HTML 验证工具集（Playwright）',
  author: 'Agent Neo',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['browser-control'],
  permissions: ['filesystem', 'network'],
  platforms: ['darwin', 'win32', 'linux'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `Browser` / `browser_action` / `browser_navigate` /
  // `validate_html_in_app`，与历史 prompt / cache / eval baseline 兼容
  api.registerToolModule(browserModule, { prefixWithPluginId: false });
  api.registerToolModule(browserActionModule, { prefixWithPluginId: false });
  api.registerToolModule(browserNavigateModule, { prefixWithPluginId: false });
  api.registerToolModule(validateHtmlInAppModule, { prefixWithPluginId: false });
  api.log(
    'info',
    `builtin.browserControl activated (tools: ${browserModule.schema.name}, ${browserActionModule.schema.name}, ${browserNavigateModule.schema.name}, ${validateHtmlInAppModule.schema.name})`,
  );
}

const entry: PluginEntry = { activate };
export default entry;
