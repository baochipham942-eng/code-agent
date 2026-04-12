// ============================================================================
// shell/ batch — Grep wrapper
//
// Bash 已在 P0-6.3 Batch 2a 迁移为 native（见 ./bash.ts）。
// Grep 仍然走 wrapper 模式，下一批会单独做 native 改造。
// KillShell/TaskOutput/GitCommit/GitDiff/GitWorktree/Process 已在 P0-5 以独立
// module 迁好。
// ============================================================================

import { grepTool } from '../../shell/grep';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

export const grepModule = wrapLegacyTool(grepTool, {
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
});
