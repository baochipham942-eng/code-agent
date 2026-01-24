/**
 * Memory Graph System - 记忆图谱系统
 *
 * 基于 Kuzu 嵌入式图数据库的记忆管理系统，
 * 支持代码实体、对话实体和知识实体的建模与检索。
 *
 * 主要组件：
 * - GraphStore: Kuzu 图数据库封装
 * - HybridStore: 向量 + 图的混合存储桥接层
 * - Types: 实体和关系的类型定义
 *
 * 使用示例：
 * ```typescript
 * import { initHybridStore, getHybridStore } from './graph';
 *
 * // 初始化
 * await initHybridStore();
 *
 * // 获取实例
 * const store = getHybridStore();
 *
 * // 添加实体
 * const entity = await store.addEntity({
 *   type: 'function',
 *   name: 'handleClick',
 *   content: 'function handleClick() { ... }',
 *   source: 'code_analysis',
 * });
 *
 * // 混合搜索
 * const results = await store.hybridSearch('button click handler', {
 *   topK: 5,
 *   includeRelations: true,
 * });
 * ```
 */

// Types
export * from './types';

// Stores
export * from './store';

// ============================================================================
// 便捷初始化函数
// ============================================================================

import { initHybridStore, getHybridStore, type HybridStore } from './store';
import type { HybridStoreConfig } from './types';

/**
 * 初始化记忆图谱系统
 */
export async function initMemoryGraph(config?: Partial<HybridStoreConfig>): Promise<HybridStore> {
  console.log('[MemoryGraph] Initializing...');
  const store = await initHybridStore(config);
  console.log('[MemoryGraph] Initialized successfully');
  return store;
}

/**
 * 获取记忆图谱实例
 */
export function getMemoryGraph(): HybridStore {
  return getHybridStore();
}
