// ============================================================================
// Tool Decorators - 工具定义装饰器
// ============================================================================
// 使用装饰器简化工具定义，减少样板代码
//
// 使用示例:
// ```typescript
// import { Tool, Param, Description, buildToolFromClass } from './decorators';
//
// @Description('Read the contents of a file from the filesystem')
// @Tool('read_file', { generations: 'gen1+', permission: 'read' })
// @Param('file_path', { type: 'string', required: true, description: 'Path to file' })
// @Param('encoding', { type: 'string', default: 'utf-8' })
// class ReadFileTool implements ITool {
//   async execute(params, context) {
//     // 实现...
//   }
// }
//
// const tool = buildToolFromClass(ReadFileTool);
// ```

// 确保 reflect-metadata 在最早被导入
import 'reflect-metadata';

// 导出装饰器
export { Tool, getToolMetadata } from './tool';
export { Param, getParamMetadata } from './param';
export { Description, getDescriptionMetadata } from './description';

// 导出类型
export type {
  ToolOptions,
  ParamOptions,
  GenerationSpec,
  ITool,
  ToolConstructor,
  ToolMetadataStored,
  ParamMetadataStored,
} from './types';

// 导出 metadata keys
export {
  TOOL_METADATA_KEY,
  PARAMS_METADATA_KEY,
  DESCRIPTION_METADATA_KEY,
} from './types';

// 导出构建器
export { buildToolFromClass, buildToolsFromClasses } from './builder';
