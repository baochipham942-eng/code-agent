// ADR-040 A1/A2 — locator 的 host 侧：revision 计算、legacy 锚点升级、写前 guard。
//
// 这里是「模型不能改坐标」这条不变量的落点。链路是：
//   renderer 只选 target（不做任何 +1/-1）→ host 补算 revision 生成 V1 → 写进 user
//   message metadata → 模型照 prompt 发 tool call → **执行前** guard 重新 resolve，
//   核对模型提交的 file_path 与坐标是否等于 resolver 结果 → 不等就不执行。
//
// 为什么 guard 必须在执行前而不是执行后校验：DocEdit 写的是用户的真文件，写完再发现
// 改错了已经晚了——非程序员既看不出被改坏，也没有回滚的直觉。

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Message, ToolCall } from '../../../shared/contract';
import {
  slideIndexFromPartName,
  validateArtifactLocatorV1,
  type ArtifactLocatorV1,
  type ArtifactRevision,
} from '../../../shared/contract/artifactLocator';
import { locatorFromLegacyAnchor, type LocalityAnchor } from '../../../shared/livePreview/localityFeedback';
import type { PresentationPackageIndexEntry } from '../../../shared/ooxml/presentationPackageIndex';
import { resolvePresentationPackageIndex } from './presentationPackageIndex';
import {
  docxParagraphTargetStillMatches,
  resolveDocxParagraphTarget,
  type DocxParagraphTargetSnapshot,
} from './docxParagraphLocator';

/** locator 授权的工具面（ADR-040 D4 首批）：Excel cell/range、Word paragraph、PPT 页内 replace。 */
const LOCATOR_GUARDED_TOOLS = new Set(['docedit', 'ppt_edit']);

export const LOCATOR_BLOCK_CODE = 'ARTIFACT_LOCATOR_MISMATCH';

export interface LocatorPreflightBlock {
  code: typeof LOCATOR_BLOCK_CODE;
  error: string;
  metadata: Record<string, unknown>;
}

/** 流式算文件 sha256。大产物（几十 MB 的 pptx）不整个读进内存。 */
export async function computeArtifactRevision(filePath: string): Promise<ArtifactRevision> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ algorithm: 'sha256', value: hash.digest('hex') }));
  });
}

/**
 * legacy 锚点 → 校验过的 V1（host 侧补 revision）。
 *
 * PPT 保留 screenshot selectedIndex 的交互输入，但 locator target 必须来自 C1 resolver；
 * 表格继续使用真实 sheetName + A1。文件读不到、selectedIndex 越界或 V1 校验失败时
 * 一律退回 legacy 字符串路径——**没有 locator 就没有 guard**，不会编造坐标。
 */
export async function upgradeLegacyAnchor(anchor: LocalityAnchor): Promise<ArtifactLocatorV1 | null> {
  let revision: ArtifactRevision;
  let resolvedPresentationTarget: PresentationPackageIndexEntry | null = null;
  try {
    if (anchor.kind === 'ppt') {
      const packageIndex = await resolvePresentationPackageIndex(anchor.filePath);
      resolvedPresentationTarget = packageIndex[anchor.slideIndex] ?? null;
    }
    revision = await computeArtifactRevision(anchor.filePath);
  } catch {
    return null;
  }

  if (anchor.kind === 'ppt-locator') {
    let packageIndex;
    let verifiedRevision: ArtifactRevision;
    try {
      packageIndex = await resolvePresentationPackageIndex(anchor.filePath);
      verifiedRevision = await computeArtifactRevision(anchor.filePath);
    } catch {
      return null;
    }
    // 避免「算 revision 后、解析 package 前」文件被外部程序替换，混出一份跨版本 locator。
    if (verifiedRevision.value !== revision.value) return null;

    const target = packageIndex[anchor.displayIndex];
    if (
      !target
      || target.relationshipId !== anchor.relationshipId
      || target.slidePartName !== anchor.slidePartName
      || target.textFingerprint !== anchor.textFingerprint
    ) {
      return null;
    }

    const locator: ArtifactLocatorV1 = {
      version: 1,
      artifact: { kind: 'presentation', filePath: anchor.filePath, revision: verifiedRevision },
      target: { kind: 'ppt-slide', ...target },
      display: {
        label: anchor.displayName || path.basename(anchor.filePath),
      },
    };
    const validation = validateArtifactLocatorV1(locator);
    return validation.ok ? validation.locator : null;
  }

  let locator: ArtifactLocatorV1 | null;
  if (anchor.kind === 'docx') {
    const resolved = await resolveDocxParagraphTarget(anchor.filePath, anchor.paragraphIndex).catch(() => null);
    if (!resolved) return null;
    locator = {
      version: 1,
      artifact: { kind: 'document', filePath: anchor.filePath, revision },
      target: resolved.target,
      display: {
        label: anchor.displayName || anchor.filePath.split('/').pop() || '文档',
        excerpt: resolved.paragraph.text,
      },
    };
  } else {
    locator = locatorFromLegacyAnchor(anchor, revision, resolvedPresentationTarget);
  }
  if (!locator) return null;

  const validation = validateArtifactLocatorV1(locator);
  return validation.ok ? validation.locator : null;
}

/** 当前生效的 locator = 最近一条带 locator 的 user 消息。之后的用户消息一旦没带，locator 即失效。 */
export function findActiveLocator(messages: readonly Message[]): ArtifactLocatorV1 | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const candidate = message.metadata?.artifactLocator;
    if (!candidate) return null; // 更近的一条用户消息没带 locator = 用户换了话题
    const validation = validateArtifactLocatorV1(candidate);
    return validation.ok ? validation.locator : null;
  }
  return null;
}

function normalizeRef(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function block(reason: string, detail: Record<string, unknown>): LocatorPreflightBlock {
  return {
    code: LOCATOR_BLOCK_CODE,
    error: reason,
    metadata: { blocked: true, skipped: true, code: LOCATOR_BLOCK_CODE, ...detail },
  };
}

/**
 * 面向用户的失败文案。**不把内部 XML part 名或 sha256 丢给用户**（ADR-040 不变量 5）：
 * 非程序员看到 "ppt/slides/slide7.xml revision 不匹配" 只会更困惑，能做的动作就一个——刷新。
 */
const STALE_MESSAGE = '文件已变化，请刷新预览后再改。';
const RETARGET_MESSAGE = '编辑目标与你选中的位置不一致，请重新选择位置。';

interface SheetOpClaim {
  ref: string;
  sheet: unknown;
}

/** 从 DocEdit 的 operations 里摘出所有「声称了单元格坐标」的 op。没有坐标的 op 不在本闸射程内。 */
function sheetOpClaims(args: Record<string, unknown> | undefined): SheetOpClaim[] {
  const operations = args?.operations;
  if (!Array.isArray(operations)) return [];

  const claims: SheetOpClaim[] = [];
  for (const op of operations) {
    if (!op || typeof op !== 'object') continue;
    const typed = op as Record<string, unknown>;
    const ref = normalizeRef(typed.cell) ?? normalizeRef(typed.range);
    if (ref) claims.push({ ref, sheet: typed.sheet });
  }
  return claims;
}

function checkSheetTarget(
  locator: ArtifactLocatorV1 & { target: { kind: 'sheet-range' } },
  args: Record<string, unknown> | undefined,
): LocatorPreflightBlock | null {
  const expectedRef = locator.target.a1.toUpperCase();
  const expectedSheet = locator.target.sheetName;

  for (const claim of sheetOpClaims(args)) {
    if (claim.ref !== expectedRef) {
      return block(RETARGET_MESSAGE, { reason: 'cell_mismatch', expected: expectedRef, received: claim.ref });
    }
    // sheet 缺省时 excelEdit 会**静默**取 workbook 第一张表（excelEdit.ts getWorksheet）。
    // 用户明明点的是第 2 张表，模型漏传 sheet 就会改错表且不报错——所以缺省即视为错配。
    if (normalizeRef(claim.sheet) !== expectedSheet.toUpperCase()) {
      return block(RETARGET_MESSAGE, {
        reason: claim.sheet === undefined ? 'sheet_omitted' : 'sheet_mismatch',
        expected: expectedSheet,
      });
    }
  }
  return null;
}

async function checkPptTarget(
  locator: ArtifactLocatorV1 & { target: { kind: 'ppt-slide' } },
  args: Record<string, unknown> | undefined,
  targetPath: string,
): Promise<LocatorPreflightBlock | null> {
  const expectedIndex = slideIndexFromPartName(locator.target.slidePartName);
  if (expectedIndex === null) {
    return block(RETARGET_MESSAGE, { reason: 'unresolvable_slide_part' });
  }
  const received = args?.slide_index;
  if (received === undefined) return null; // 不声称页码的 action（如 extract_style）不在射程内
  if (received !== expectedIndex) {
    return block(RETARGET_MESSAGE, { reason: 'slide_mismatch', expected: expectedIndex, received });
  }

  let packageIndex;
  try {
    packageIndex = await resolvePresentationPackageIndex(targetPath);
  } catch {
    return block(STALE_MESSAGE, { reason: 'presentation_package_unreadable' });
  }
  const currentTarget = packageIndex[locator.target.displayIndex];
  if (!currentTarget) return block(STALE_MESSAGE, { reason: 'presentation_target_missing' });
  if (currentTarget.relationshipId !== locator.target.relationshipId) {
    return block(STALE_MESSAGE, { reason: 'relationship_drift' });
  }
  if (currentTarget.slidePartName !== locator.target.slidePartName) {
    return block(STALE_MESSAGE, { reason: 'slide_part_drift' });
  }
  if (currentTarget.textFingerprint !== locator.target.textFingerprint) {
    return block(STALE_MESSAGE, { reason: 'text_fingerprint_drift' });
  }
  return null;
}

function checkDocxTarget(
  locator: ArtifactLocatorV1 & { target: { kind: 'docx-paragraph' } },
  args: Record<string, unknown> | undefined,
): LocatorPreflightBlock | null {
  const expectedIndex = locator.target.paragraphIndex;
  const operations = args?.operations;
  if (!Array.isArray(operations)) return null;

  for (const op of operations) {
    if (!op || typeof op !== 'object') continue;
    const typed = op as Record<string, unknown>;
    const action = typed.action;
    const received = action === 'insert_paragraph'
      ? typed.after
      : action === 'replace_paragraph' || action === 'delete_paragraph'
        ? typed.index
        : undefined;
    if (received === undefined) {
      return block(RETARGET_MESSAGE, { reason: 'paragraph_operation_unsupported' });
    }
    if (received !== expectedIndex) {
      return block(RETARGET_MESSAGE, { reason: 'paragraph_mismatch', expected: expectedIndex, received });
    }
  }
  return null;
}

/**
 * 写前 guard：locator 生效时，核对模型提交的 file_path 与坐标是否等于 resolver 结果。
 *
 * 返回 null = 放行（没有 locator、或工具不在授权面内、或全部对得上）。
 * 返回 block = **不调用写工具**（ADR-040 不变量 5：失败可见且不落盘）。
 */
export async function getArtifactLocatorPreflightBlock(
  ctx: { messages: readonly Message[]; workingDirectory: string },
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): Promise<LocatorPreflightBlock | null> {
  if (!LOCATOR_GUARDED_TOOLS.has(toolCall.name.toLowerCase())) return null;

  const locator = findActiveLocator(ctx.messages);
  if (!locator) return null;

  const rawPath = toolCall.arguments?.file_path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return block(RETARGET_MESSAGE, { reason: 'missing_file_path' });
  }
  const targetPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(ctx.workingDirectory, rawPath);
  if (targetPath !== path.resolve(locator.artifact.filePath)) {
    return block(RETARGET_MESSAGE, { reason: 'file_mismatch' });
  }

  // revision fail-closed：点击后、写入前重新计算。外部程序在用户点选后改了文件，
  // 旧坐标就不再指向用户当时看到的东西——宁可让用户刷新一次，也不猜。
  let current: ArtifactRevision;
  try {
    current = await computeArtifactRevision(targetPath);
  } catch {
    return block(STALE_MESSAGE, { reason: 'revision_unreadable' });
  }
  if (current.value !== locator.artifact.revision.value) {
    return block(STALE_MESSAGE, { reason: 'revision_drift' });
  }

  switch (locator.target.kind) {
    case 'sheet-range':
      return checkSheetTarget(locator as ArtifactLocatorV1 & { target: { kind: 'sheet-range' } }, toolCall.arguments);
    case 'ppt-slide':
      return checkPptTarget(
        locator as ArtifactLocatorV1 & { target: { kind: 'ppt-slide' } },
        toolCall.arguments,
        targetPath,
      );
    case 'docx-paragraph':
      if (!await docxParagraphTargetStillMatches(
        targetPath,
        locator.target as DocxParagraphTargetSnapshot,
      ).catch(() => false)) {
        return block(STALE_MESSAGE, { reason: 'paragraph_fingerprint_drift' });
      }
      return checkDocxTarget(locator as ArtifactLocatorV1 & { target: { kind: 'docx-paragraph' } }, toolCall.arguments);
  }
}
