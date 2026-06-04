// 定点反馈 loop — 产物锚点 → 消息文本构造器（Phase 2/3：PPT / 表格）
//
// 网页(Phase 1)走结构化 envelope.livePreviewSelection + workbenchTurnContext 注入；
// PPT/表格(Phase 2/3)不走 envelope 字段（slide_index/cell 套不进 SelectedElementInfo），
// 而是把锚点（文件路径 + 页码/单元格）编进消息文本，让模型自路由到 ppt_edit/excel_edit。
// 消息格式经真模型 E2E 验证（scripts/acceptance/locality-feedback-ppt-e2e.ts）。

/** PPT 某页锚点：overlay 点选某页时已知 0-based slide_index + 背后 .pptx 路径 */
export interface PptLocalityAnchor {
  kind: 'ppt';
  /** 要编辑的 .pptx 绝对路径（design_ppt 预览的 pptxPath） */
  filePath: string;
  /** 0-based 幻灯片索引（DesignPptPreview 的 selectedIndex，直接对应 ppt_edit.slide_index） */
  slideIndex: number;
  /** 展示名（标题/文件名），仅用于消息可读性 */
  displayName?: string;
}

/** 表格某单元格/区域锚点：overlay 点选单元格时已知 cell 引用 + 文件路径 */
export interface SheetLocalityAnchor {
  kind: 'sheet';
  /** 要编辑的表格文件绝对路径 */
  filePath: string;
  /** 单元格引用，如 "B7"；区域用 "A1:C2" */
  cell: string;
  /** 工作表名，如 "Sheet1"（缺省让模型用默认表） */
  sheetName?: string;
  displayName?: string;
}

export type LocalityAnchor = PptLocalityAnchor | SheetLocalityAnchor;

function pptMessage(a: PptLocalityAnchor, feedback: string): string {
  const name = a.displayName || a.filePath.split('/').pop() || 'PPT';
  return (
    `[定点反馈] 用户在 PPT 预览里点选了《${name}》的第 ${a.slideIndex + 1} 页` +
    `（文件路径：${a.filePath}，slide_index=${a.slideIndex}）。\n` +
    `针对这一页的诉求：${feedback}。\n` +
    `请用 ppt_edit 工具，file_path 用上面给的路径，slide_index 用 ${a.slideIndex}，做定向修改` +
    `——只改这一页，不要动别的页。`
  );
}

function sheetMessage(a: SheetLocalityAnchor, feedback: string): string {
  const name = a.displayName || a.filePath.split('/').pop() || '表格';
  const sheetClause = a.sheetName ? `工作表「${a.sheetName}」的` : '';
  return (
    `[定点反馈] 用户在表格预览里点选了《${name}》${sheetClause}单元格 ${a.cell}` +
    `（文件路径：${a.filePath}）。\n` +
    `针对这个位置的诉求：${feedback}。\n` +
    `请调用 DocEdit 工具，file_path 用上面给的路径，` +
    `定位到${sheetClause}${a.cell}，做定向修改——只改这个位置相关的内容。`
  );
}

/**
 * 把产物锚点 + 用户反馈文本拼成发给 agent 的消息。
 * 返回的字符串直接走 useMessageActionStore.sendPrompt → 主循环按文本自路由到对应编辑工具。
 */
export function buildLocalityFeedbackMessage(anchor: LocalityAnchor, feedback: string): string {
  const text = feedback.trim();
  switch (anchor.kind) {
    case 'ppt':
      return pptMessage(anchor, text);
    case 'sheet':
      return sheetMessage(anchor, text);
  }
}
