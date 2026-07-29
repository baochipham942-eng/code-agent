// ============================================================================
// PendingCommandChip - 特色命令 chip（2026-07-29 UX round2 任务 17）
// ============================================================================
//
// 特色命令的图标映射（goal/schedule/loop/workflow）。chip 本体已随命令内联进文字流
// （InlineComposerChip，2026-07-29 WorkBuddy phrase chip 模型），本文件只保留共享图标表。

import { Clock3, GitBranch, Repeat, Target } from 'lucide-react';

// 导出给内联 chip（InlineComposerChip）复用同一套命令图标
export const COMMAND_ICONS: Record<string, typeof Target> = {
  goal: Target,
  schedule: Clock3,
  loop: Repeat,
  workflow: GitBranch,
};
