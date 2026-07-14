import {
  slideIndexFromPartName,
  type ArtifactLocatorV1,
  type ArtifactRevision,
} from '../contract/artifactLocator';
import type { PresentationPackageIndexEntry } from '../ooxml/presentationPackageIndex';

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

/**
 * PPT 定点反馈消息。
 *
 * displayPage 与 slideIndex 是**两个不同的数**，必须分别传入：前者是用户在预览里看到的
 * 页序（1-based），后者是 ppt_edit 的写入坐标。乱序 deck 里用户看到的第 2 页完全可能
 * 指向 slide7.xml（slide_index=6）。旧的 LocalityAnchor 只有一个 slideIndex，靠
 * 「生成的 PPT 恰好连续同序」才没出事——那是巧合，不是契约（ADR-040）。
 */
function pptMessage(
  a: { filePath: string; displayName?: string },
  displayPage: number,
  slideIndex: number,
  feedback: string,
): string {
  const name = a.displayName || a.filePath.split('/').pop() || 'PPT';
  return (
    `[定点反馈] 用户在 PPT 预览里点选了《${name}》的第 ${displayPage} 页` +
    `（文件路径：${a.filePath}，slide_index=${slideIndex}）。\n` +
    `针对这一页的诉求：${feedback}。\n` +
    `请用 ppt_edit 工具，file_path 用上面给的路径，slide_index 用 ${slideIndex}，做定向修改` +
    `——只改这一页，不要动别的页。`
  );
}

function sheetMessage(
  a: { filePath: string; displayName?: string },
  cell: string,
  sheetName: string | undefined,
  feedback: string,
): string {
  const name = a.displayName || a.filePath.split('/').pop() || '表格';
  const sheetClause = sheetName ? `工作表「${sheetName}」的` : '';
  return (
    `[定点反馈] 用户在表格预览里点选了《${name}》${sheetClause}单元格 ${cell}` +
    `（文件路径：${a.filePath}）。\n` +
    `针对这个位置的诉求：${feedback}。\n` +
    `请调用 DocEdit 工具，file_path 用上面给的路径，` +
    `定位到${sheetClause}${cell}，做定向修改——只改这个位置相关的内容。`
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
      // legacy 锚点里显示页与 slide_index 是同一个数（连续 deck 的巧合）。
      return pptMessage(anchor, anchor.slideIndex + 1, anchor.slideIndex, text);
    case 'sheet':
      return sheetMessage(anchor, anchor.cell, anchor.sheetName, text);
  }
}

/**
 * ArtifactLocatorV1 → 发给模型的定点反馈消息（ADR-040 A1 的 deterministic serializer）。
 *
 * 对 Excel 与生成的 PPT，输出与 buildLocalityFeedbackMessage 逐字节一致——迁移到 V1
 * 不改变模型看到的任何东西，既有 prompt 回归测试即是这条的门。
 */
export function buildLocatorFeedbackMessage(locator: ArtifactLocatorV1, feedback: string): string {
  const text = feedback.trim();
  const base = { filePath: locator.artifact.filePath, displayName: locator.display.label };

  switch (locator.target.kind) {
    case 'sheet-range':
      return sheetMessage(base, locator.target.a1, locator.target.sheetName, text);
    case 'ppt-slide': {
      const slideIndex = slideIndexFromPartName(locator.target.slidePartName);
      if (slideIndex === null) {
        throw new Error(`locator 的 slidePartName 非法：${locator.target.slidePartName}`);
      }
      return pptMessage(base, locator.target.displayIndex + 1, slideIndex, text);
    }
    case 'docx-paragraph':
      // ADR-040 P0：Word 的 index prompt 继续禁用，直到 B1 的 XML resolver 与契约测试
      // 同时通过（工单 B2）。这里 throw 而不是拼一条 prompt，是因为护栏必须是机制——
      // 留一条「暂时没人调用」的可用代码，等于把闸门寄托在调用方的自觉上。
      throw new Error('ADR-040 P0：Word 段落 locator 的 prompt 尚未启用（见工单 B2）');
  }
}

/**
 * legacy LocalityAnchor → ArtifactLocatorV1（ADR-040 A3 兼容适配器）。
 *
 * revision 必须由 host 侧现算后传入：legacy 锚点根本没有这个字段，而 V1 的
 * fail-closed 语义要求它必填。renderer 传上来的任何 revision 都不算数。
 *
 * PPT 的 relationshipId / slidePartName / textFingerprint 必须来自 C1 presentation
 * package resolver；legacy 锚点只保留 screenshot selectedIndex 的交互输入，不能自行
 * 推导执行坐标。resolvedPresentationTarget 为空或与 selectedIndex 不一致时 fail-closed。
 *
 * 返回 null = 这个锚点拿不到诚实的 V1，继续走 legacy 字符串路径（不上 guard，行为与
 * 今天完全一致）。表格仅剩一种情况：**无 sheetName 的表格锚点**。V1 把 sheetName
 * 当必填生产项。现行生产者
 *    （SpreadsheetBlock）已随锚点发出真实表名，走不到这条；真缺时宁可退回 legacy，
 *    也不猜一个表名去改用户的工作簿。
 */
export function locatorFromLegacyAnchor(
  anchor: LocalityAnchor,
  revision: ArtifactRevision,
  resolvedPresentationTarget: PresentationPackageIndexEntry | null,
): ArtifactLocatorV1 | null {
  if (anchor.kind === 'ppt') {
    if (!resolvedPresentationTarget || resolvedPresentationTarget.displayIndex !== anchor.slideIndex) return null;
    return {
      version: 1,
      artifact: { kind: 'presentation', filePath: anchor.filePath, revision },
      target: { kind: 'ppt-slide', ...resolvedPresentationTarget },
      display: { label: anchor.displayName || anchor.filePath.split('/').pop() || 'PPT' },
    };
  }

  if (!anchor.sheetName) return null;

  return {
    version: 1,
    artifact: { kind: 'spreadsheet', filePath: anchor.filePath, revision },
    target: { kind: 'sheet-range', sheetName: anchor.sheetName, a1: anchor.cell },
    display: { label: anchor.displayName || anchor.filePath.split('/').pop() || '表格' },
  };
}
