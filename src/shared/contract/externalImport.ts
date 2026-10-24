// ============================================================================
// External Import Types - 设置页「从其他 AI 应用导入」（N-EXTHISTORY-IMPORT-K1A）
// ============================================================================
//
// 检测/导入 Claude Code、Codex、Cursor、Grok Build、Qwen Code、Gemini CLI 的本机
// 数据。记忆与指令复用 memory.ts 的 harness 导入管线（memoryHarnessImport* 域
// action），本文件只补「来源检测汇总」与「技能复制」两类形状。MCP servers 是后续
// 单（N-EXTHISTORY-IMPORT-K1B-MCP）追加的 category，形状按 category 列表数据驱动。

import type { MemoryImportAdapterId } from './memory';

export type ExternalImportSourceId =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'grok-build'
  | 'qwen-code'
  | 'gemini-cli';

/** 技能走复制的来源；Claude 按拍板 A 原地读取，不复制。 */
export type ExternalSkillCopySourceId = 'codex' | 'cursor';

export type ExternalImportCategory = 'instructions' | 'memories' | 'skills';

export interface ExternalImportCategoryCount {
  category: ExternalImportCategory;
  count: number;
  /** true = 只读展示（Claude 技能原地读取 + 全局开关），不参与导入勾选 */
  readOnly?: boolean;
}

export interface ExternalImportSourceStatus {
  sourceId: ExternalImportSourceId;
  adapterId?: MemoryImportAdapterId;
  /** 来源主目录的展示形态（如 ~/.codex） */
  homePath: string;
  detected: boolean;
  categories: ExternalImportCategoryCount[];
  /** 检测期剔除该来源的原因（如 adapter 显式选择仍失败） */
  excludedReason?: string;
}

export interface ExternalImportDetectResult {
  /** 检测基准 home（CODE_AGENT_HOME 优先），展示用 */
  homeDir: string;
  sources: ExternalImportSourceStatus[];
  /** 任一来源 detected —— 设置页入口与记忆页链接的显隐判据 */
  anyDetected: boolean;
  claudeLegacySkills: {
    /** 原地读取开关当前生效值（缺省开） */
    enabled: boolean;
    /** ~/.claude/skills 下可被发现的技能数 */
    count: number;
  };
}

export interface ExternalSkillsPreviewRequest {
  sourceIds?: ExternalSkillCopySourceId[];
}

export interface ExternalSkillPlanItem {
  sourceId: ExternalSkillCopySourceId;
  name: string;
  sourcePath: string;
  disposition: 'copy' | 'skip';
  reason: 'new-skill' | 'target-name-exists';
}

export interface ExternalSkillsPreviewResult {
  items: ExternalSkillPlanItem[];
  summary: { copy: number; skip: number };
}

export interface ExternalSkillsApplyRequest {
  sourceIds?: ExternalSkillCopySourceId[];
}

export interface ExternalSkillsApplyResultItem {
  sourceId: ExternalSkillCopySourceId;
  name: string;
  action: 'copied' | 'skipped';
  reason?: 'target-name-exists' | 'copy-failed';
  error?: string;
}

export interface ExternalSkillsApplyResult {
  /** 复制目标（Neo 用户技能目录） */
  targetDir: string;
  copied: number;
  skipped: number;
  items: ExternalSkillsApplyResultItem[];
}

export interface ExternalImportSetClaudeLegacySkillsRequest {
  enabled: boolean;
}

export interface ExternalImportSetClaudeLegacySkillsResult {
  /** 落盘后回读的生效值（写失败时与请求值可能不同，UI 以此为准） */
  enabled: boolean;
}
