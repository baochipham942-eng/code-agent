// ============================================================================
// editToolArgs - Edit 参数形状归一（N-EDIT-RETRY-KEY-SHAPE）
//
// 注册的 Edit 工具（src/host/tools/modules/file/multiEdit.schema.ts）参数形状是
// { file_path, edits: [{ old_text, new_text, replace_all? }] }；历史 legacy
// edit_file 是顶层平铺 { file_path, old_string, new_string, replace_all? }。
// 展示/摘要/恢复判定各处原先只会读平铺形状，真实 Edit 调用一律读空——这里是
// 唯一归一入口，两种形状都归一成「路径 + 编辑项列表」。
// ============================================================================

interface NormalizedEditItem {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

interface NormalizedEditArgs {
  filePath: string;
  edits: NormalizedEditItem[];
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizeEditItem(edit: Record<string, unknown>): NormalizedEditItem | null {
  // backward compat: old_string/new_string → old_text/new_text（同 multiEdit.ts normalizeEdits）
  const oldText = readStringField(edit, 'old_text') ?? readStringField(edit, 'old_string');
  const newText = readStringField(edit, 'new_text') ?? readStringField(edit, 'new_string');
  if (oldText === undefined || newText === undefined) return null;
  return { oldText, newText, replaceAll: edit.replace_all === true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把 Edit / legacy edit_file 的参数归一成「路径 + 编辑项列表」。
 * 优先读 edits[]（真实注册形状，逐项 old_text/new_text，回退 old_string/new_string），
 * 无 edits[] 时回退顶层平铺 old_string/new_string（legacy edit_file）。
 * 形状不可用（缺路径、edits[] 非法或为空、平铺字段不齐）返回 null。
 */
export function normalizeEditArgs(args: unknown): NormalizedEditArgs | null {
  if (!isRecord(args)) return null;
  const filePath = args.file_path ?? args.path;
  if (typeof filePath !== 'string' || filePath === '') return null;

  if (args.edits !== undefined) {
    if (!Array.isArray(args.edits)) return null;
    const edits: NormalizedEditItem[] = [];
    for (const entry of args.edits) {
      if (!isRecord(entry)) return null;
      const item = normalizeEditItem(entry);
      if (!item) return null;
      edits.push(item);
    }
    if (edits.length === 0) return null;
    return { filePath, edits };
  }

  const flat = normalizeEditItem(args);
  return flat ? { filePath, edits: [flat] } : null;
}

/**
 * 聚合编辑项文本（多 item 按序以 \n 拼接 old/new 两串），供 diff/摘要类读者
 * 一屏取文。形状不可用返回空串二元组，等价于旧代码读不到字段时的兜底。
 */
export function aggregateEditArgsText(args: unknown): { oldText: string; newText: string } {
  const normalized = normalizeEditArgs(args);
  if (!normalized) return { oldText: '', newText: '' };
  return {
    oldText: normalized.edits.map((item) => item.oldText).join('\n'),
    newText: normalized.edits.map((item) => item.newText).join('\n'),
  };
}
