// ============================================================================
// shell/ batch (P0-6.2) — Bash / Grep wrapper
//
// 两个生产级核心 shell tool（legacy 实现）wrap 进 protocol registry。
// KillShell/TaskOutput/GitCommit/GitDiff/GitWorktree/Process 已在 P0-5 以独立
// module 迁好。
// ============================================================================

import { bashTool } from '../../shell/bash';
import { grepTool } from '../../shell/grep';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

export const bashModule = wrapLegacyTool(bashTool, {
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
});

export const grepModule = wrapLegacyTool(grepTool, {
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
});
