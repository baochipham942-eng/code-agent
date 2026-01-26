// ============================================================================
// Decorated Tools - Export all decorator-based tool classes
// ============================================================================
//
// 这些工具使用装饰器语法定义，作为新工具定义方式的示例。
// 可以与现有的对象式工具定义并存，ToolRegistry 同时支持两种方式。
//
// ## 使用方法
//
// ```typescript
// import { DecoratedToolClasses } from './decorated';
//
// // 在 ToolRegistry 中注册
// toolRegistry.registerClasses(DecoratedToolClasses);
// ```
//
// ## 对比
//
// ### 原版对象式定义（约 100 行）
// ```typescript
// export const bashTool: Tool = {
//   name: 'bash',
//   description: '...',
//   generations: ['gen1', 'gen2', ...],
//   inputSchema: { type: 'object', properties: {...}, required: [...] },
//   async execute(params, context) { ... }
// };
// ```
//
// ### 装饰器定义（约 60 行，更清晰的结构）
// ```typescript
// @Tool('bash', { generations: 'gen1+', permission: 'execute' })
// @Description('...')
// @Param('command', { type: 'string', required: true })
// class BashTool implements ITool {
//   async execute(params, context) { ... }
// }
// ```
//
// ============================================================================

export { GlobTool } from './GlobTool';
export { ReadFileTool } from './ReadFileTool';
export { BashTool } from './BashTool';

import { GlobTool } from './GlobTool';
import { ReadFileTool } from './ReadFileTool';
import { BashTool } from './BashTool';
import type { ITool } from '../decorators';

/**
 * 所有使用装饰器定义的工具类
 *
 * 注意：这些只是示例，目前未替换原有工具。
 * 如需启用装饰器版本，需要在 ToolRegistry 中替换原有注册。
 */
export const DecoratedToolClasses: Array<new () => ITool> = [
  GlobTool,
  ReadFileTool,
  BashTool,
];
