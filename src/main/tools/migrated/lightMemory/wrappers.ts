// ============================================================================
// lightMemory/ batch (P0-6.2) — MemoryRead / MemoryWrite wrapper
//
// lightMemory 不在 legacy tools/<category>/ 目录下（独立 module），ESLint gate
// 不限制其 import。这里用 wrapLegacyTool 模式统一成 protocol ToolModule。
// ============================================================================

import { memoryReadTool } from '../../../lightMemory/memoryReadTool';
import { memoryWriteTool } from '../../../lightMemory/memoryWriteTool';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

export const memoryReadModule = wrapLegacyTool(memoryReadTool, {
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
});

export const memoryWriteModule = wrapLegacyTool(memoryWriteTool, {
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
});
