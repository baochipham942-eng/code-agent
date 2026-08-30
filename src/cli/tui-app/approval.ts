// ============================================================================
// Ink TUI 权限审批卡的数据逻辑（纯函数，无 Ink 依赖，可单测）
// 规格：docs/design/2026-08-29-ink-tui-grok-interaction-spec.md「权限确认」节
// P1 扩充：Allow all edits this session / never allow / No 附反馈 /
// 文件写入类变更摘要 + 可展开 inline diff。
// ============================================================================

import type { PermissionRequestData } from '../../host/tools/types';

/** 审批卡选项（数字键直选 + ↑↓+Enter） */
export type ApprovalChoice =
  | 'once'
  | 'session-edits'
  | 'always'
  | 'never'
  | 'reject'
  | 'reject-feedback';

export interface ApprovalOption {
  choice: ApprovalChoice;
  /** 显示文案（含 always/never 的目标） */
  label: string;
}

/** 文件写入/编辑类请求（"Allow all edits this session" 只对这类出现） */
function isEditClassRequest(request: PermissionRequestData): boolean {
  return request.type === 'file_write' || request.type === 'file_edit';
}

/**
 * "Always allow" 的授权 key：命令类取首 token（npm/git/…），其余取工具名。
 * 会话级内存集合，不持久化。
 */
export function approvalKey(request: PermissionRequestData): string {
  if ((request.type === 'command' || request.type === 'dangerous_command') && request.details?.command) {
    const command = String(request.details.command).trim();
    const firstToken = command.split(/\s+/)[0] || command;
    return `bash:${firstToken}`;
  }
  return `tool:${request.tool}`;
}

/** 卡片上的目标摘要：bash 命令 / 文件路径 / URL（单行截断） */
export function approvalTarget(request: PermissionRequestData): string {
  const raw = String(
    request.details?.command
    || request.details?.path
    || request.details?.filePath
    || request.details?.url
    || request.tool,
  );
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 72 ? oneLine.slice(0, 69) + '...' : oneLine;
}

/**
 * 卡片选项组合：
 * Allow once / [Allow all edits this session] / Always allow: <目标> /
 * Never allow: <目标> / No, reject / No, reject with feedback
 */
export function approvalOptions(request: PermissionRequestData): ApprovalOption[] {
  const key = approvalKey(request);
  const keyTarget = key.startsWith('bash:') ? key.slice('bash:'.length) : request.tool;
  const options: ApprovalOption[] = [{ choice: 'once', label: 'Allow once' }];
  if (isEditClassRequest(request)) {
    options.push({ choice: 'session-edits', label: 'Allow all edits this session' });
  }
  options.push(
    { choice: 'always', label: `Always allow: ${keyTarget}` },
    { choice: 'never', label: `Never allow: ${keyTarget}` },
    { choice: 'reject', label: 'No, reject' },
    { choice: 'reject-feedback', label: 'No, reject with feedback' },
  );
  return options;
}

// ---------------------------------------------------------------------------
// 文件写入类变更摘要 + inline diff
// ---------------------------------------------------------------------------

/** 写入类变更摘要（一行）：edit → `+N -M lines`；write/append → `N bytes new content` */
export function writeChangeSummary(request: PermissionRequestData): string | null {
  if (request.type === 'file_edit') {
    const oldLines = splitLines(String(request.details?.oldString ?? ''));
    const newLines = splitLines(String(request.details?.newString ?? ''));
    if (oldLines.length === 0 && newLines.length === 0) return null;
    return `+${newLines.length} -${oldLines.length} lines`;
  }
  if (request.type === 'file_write') {
    const length = Number(request.details?.contentLength ?? 0);
    return length > 0 ? `${length} bytes new content` : null;
  }
  return null;
}

export interface EditDiffPreview {
  /** 删除行（oldString），已按 maxLines 截断 */
  removedLines: string[];
  /** 新增行（newString），已按 maxLines 截断 */
  addedLines: string[];
  /** 完整行数（摘要与截断标记用） */
  removedTotal: number;
  addedTotal: number;
  truncated: boolean;
}

/**
 * edit_file 审批的 inline diff 数据：oldString → - 行块，newString → + 行块
 * （edit 的 old/new 是完整替换段，块级展示即准确，不做 LCS）。
 * 非 edit 请求或两端皆空返回 null。
 */
export function editDiffPreview(request: PermissionRequestData, maxLines = 8): EditDiffPreview | null {
  if (request.type !== 'file_edit') return null;
  const removed = splitLines(String(request.details?.oldString ?? ''));
  const added = splitLines(String(request.details?.newString ?? ''));
  if (removed.length === 0 && added.length === 0) return null;
  return {
    removedLines: removed.slice(0, maxLines),
    addedLines: added.slice(0, maxLines),
    removedTotal: removed.length,
    addedTotal: added.length,
    truncated: removed.length > maxLines || added.length > maxLines,
  };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

// ---------------------------------------------------------------------------
// 会话级放行 / 拒批集合
// ---------------------------------------------------------------------------

/**
 * 会话级授权状态（always 写入放行集合，never 写入拒批集合，
 * "Allow all edits" 放开整个编辑类；均会话内存，不持久化）。
 * 拒批命中时 provider 直接拒（denialSource=user），不再弹卡。
 */
export class SessionAllowList {
  private readonly keys = new Set<string>();
  private readonly deniedKeys = new Set<string>();
  private allEdits = false;

  has(request: PermissionRequestData): boolean {
    if (this.allEdits && isEditClassRequest(request)) return true;
    return this.keys.has(approvalKey(request));
  }

  /** never allow 命中：后续同 key 请求直接拒，不再询问 */
  isDenied(request: PermissionRequestData): boolean {
    return this.deniedKeys.has(approvalKey(request));
  }

  add(request: PermissionRequestData): void {
    this.keys.add(approvalKey(request));
  }

  addAllEdits(): void {
    this.allEdits = true;
  }

  deny(request: PermissionRequestData): void {
    this.deniedKeys.add(approvalKey(request));
  }

  get size(): number {
    return this.keys.size;
  }
}
