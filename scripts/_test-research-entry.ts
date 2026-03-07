/**
 * Deep Research 测试入口 — 仅导出测试需要的模块
 *
 * 通过 esbuild 打包为 CJS bundle。
 * 关键: electron-mock 必须最先导入并注入到 require 链中。
 * 由于 esbuild CJS 输出中 entry module 最后执行，而所有 __esm 模块惰性初始化，
 * 这里的 Module.prototype.require 补丁会在其他模块首次 require('electron') 之前生效。
 *
 * 模式验证: 与 scripts/real-test-entry.ts (build:test-runner) 完全一致。
 */

// 1. electron mock + require 拦截（必须最先）
import electronMock from '../src/cli/electron-mock';

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'electron' || id === 'electron/main') {
    return electronMock;
  }
  return originalRequire.apply(this, arguments);
};

// 2. 导出测试需要的模块
export { DeepResearchMode } from '../src/main/research/deepResearchMode';
export type { DeepResearchModeConfig, DeepResearchResult } from '../src/main/research/deepResearchMode';
export type { DeepResearchConfig } from '../src/main/research/types';
export { ModelRouter } from '../src/main/model/modelRouter';
export { ToolRegistry } from '../src/main/tools/toolRegistry';
export { ToolExecutor } from '../src/main/tools/toolExecutor';
export type { ToolExecutorConfig } from '../src/main/tools/toolExecutor';
export { getConfigService } from '../src/main/services/core/configService';
