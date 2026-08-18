// ============================================================================
// Protocol Tool Registry — 单例 + 工具注册
//
// 职责：
// 1. 暴露 getProtocolRegistry() 单例，首次调用时 lazy 创建 + 注册已迁移工具
// 2. 暴露 isProtocolToolName() 判断一个工具名是否在 protocol registry 中
//
// 和 legacy toolRegistry.ts 完全独立，不互相 import。
// ============================================================================

import { ToolRegistry } from './registry';
import { registerMigratedTools } from './modules';
import { setProtocolToolRegistryPort } from './protocolToolRegistration';
import { setProtocolToolNameChecker } from '../services/toolSearch/toolSearchService';

let singleton: ToolRegistry | null = null;

/** 单例访问，首次调用时注册已迁移 tool */
export function getProtocolRegistry(): ToolRegistry {
  if (!singleton) {
    singleton = new ToolRegistry();
    registerMigratedTools(singleton);
  }
  return singleton;
}

/** 测试用：重置单例，让下一次 get 重新注册 */
export function resetProtocolRegistry(): void {
  singleton = null;
}

/** 判断一个 tool 名字是否已在 protocol registry 中注册 */
export function isProtocolToolName(name: string): boolean {
  return getProtocolRegistry().has(name);
}

/**
 * 文字指挥台前台工具面（ADR-059）。
 *
 * 工具是否适用由各自 schema 的 allowInTextForeground 声明决定；这里不维护工具名清单。
 * 每轮重新读取 registry，确保启动后注册的 builtin plugin 也遵循同一判据。
 */
export function getTextForegroundToolNames(): string[] {
  return getProtocolRegistry()
    .getSchemas()
    .filter((schema) => schema.allowInTextForeground === true)
    .map((schema) => schema.name);
}

setProtocolToolNameChecker(isProtocolToolName);
setProtocolToolRegistryPort({
  register: (schema, loader) => getProtocolRegistry().register(schema, loader),
  unregister: (name) => getProtocolRegistry().unregister(name),
  has: (name) => getProtocolRegistry().has(name),
  getSchemas: () => getProtocolRegistry().getSchemas(),
  resolve: (name) => getProtocolRegistry().resolve(name),
});
