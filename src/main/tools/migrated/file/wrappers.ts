// ============================================================================
// file/ batch (P0-6.2) — Read / Write / Glob wrapper
//
// 三个生产级核心文件 tool（legacy 实现）wrap 进 protocol registry。
// Edit/ListDirectory/NotebookEdit/ReadClipboard 已在 P0-5 以独立 module 迁好。
// ============================================================================

import { readFileTool } from '../../file/read';
import { writeFileTool } from '../../file/write';
import { globTool } from '../../file/glob';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

const FS_READ = {
  category: 'fs' as const,
  permissionLevel: 'read' as const,
  readOnly: true,
  allowInPlanMode: true,
};

const FS_WRITE = {
  category: 'fs' as const,
  permissionLevel: 'write' as const,
  readOnly: false,
  allowInPlanMode: false,
};

export const readModule = wrapLegacyTool(readFileTool, FS_READ);
export const writeModule = wrapLegacyTool(writeFileTool, FS_WRITE);
export const globModule = wrapLegacyTool(globTool, FS_READ);
