// ============================================================================
// Artifact Render Review — docx/pdf/xlsx 交付前渲染审查
//
// 接入点选 deliverableDiskCheck 的有界补轮（messageProcessor 落库前）：
// turnOutcomeStamp 是收尾侧账、不能回喂模型，修 3 轮必须走补轮闸。
// LibreOffice 不可用时跳过审查并盖「未做视觉验证」，不把 skipped 当成通过。
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { ARTIFACT_RENDER_REVIEW } from '../../../shared/constants/agent';
import type { Message } from '../../../shared/contract';
import type { ContextInjectionSource } from '../../../shared/contract/contextView';
import { createLogger } from '../../services/infra/logger';
import {
  isLibreOfficeAvailable,
  convertOfficeToPdf,
  rasterizePdfToImages,
} from '../../tools/media/officeRaster';
import {
  collectDeliverableClaims,
  runDeliverableDiskCheckGate,
  type DeliverableClaim,
} from './deliverableDiskCheck';
import type { ArtifactRenderReviewStamp, DeclaredDeliverables } from './artifactState';

const logger = createLogger('ArtifactRenderReview');

const RENDERABLE = new Set<string>(ARTIFACT_RENDER_REVIEW.RENDERABLE_EXTENSIONS);

export type ArtifactRenderIssueKind =
  | 'overflow'
  | 'overlap'
  | 'cramped'
  | 'low_contrast'
  | 'template_residue';

export type ArtifactRenderIssue = {
  file: string;
  page: number;
  kind: ArtifactRenderIssueKind;
  description: string;
  severity: 'high' | 'medium' | 'low';
};

export type ArtifactRenderReviewStatus = ArtifactRenderReviewStamp['status'];

export type ArtifactRenderVlm = (prompt: string, imagePath: string) => Promise<string>;

const ISSUE_KINDS: ArtifactRenderIssueKind[] = [
  'overflow', 'overlap', 'cramped', 'low_contrast', 'template_residue',
];

function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function isRenderableClaim(claim: DeliverableClaim): boolean {
  return RENDERABLE.has(extensionOf(claim.resolved));
}

export function formatVisualReviewProblems(stamp: ArtifactRenderReviewStamp): string[] {
  if (stamp.status === 'skipped_no_libreoffice' || stamp.status === 'skipped_no_vlm') {
    return ['VISUAL_REVIEW_SKIPPED: 未做视觉验证'];
  }
  return stamp.issues.map((issue) =>
    `VISUAL_REVIEW_ISSUE: ${issue.file} p.${issue.page} ${issue.kind}: ${issue.description}`);
}

function needsRevision(issues: readonly ArtifactRenderIssue[]): boolean {
  return issues.some((issue) =>
    issue.kind === 'overflow'
    || issue.kind === 'overlap'
    || issue.severity !== 'low');
}

function pageReviewPrompt(pageNumber: number, kind: string): string {
  return `你是文档版面审查员。请看这张「${kind}」第 ${pageNumber} 页的渲染图。按这个顺序检查，只报告看得到的问题：
1. overflow：文字溢出或被截断、表格出页被裁切
2. overlap：元素重叠、碰撞、互相遮挡
3. cramped：间距挤压、分布不均、挤成一团
4. low_contrast：文字与背景对比过低、难以阅读
5. template_residue：模板装饰/占位框/示例水印残留

只返回 JSON，不要其他文字：
{"passed": true, "issues": []}
或
{"passed": false, "issues": [{"kind": "overflow", "description": "用你看见的具体内容写，不要照抄本说明", "severity": "high"}]}
kind 只能是 overflow | overlap | cramped | low_contrast | template_residue
severity: high（影响阅读）| medium（明显难看）| low（微调）
没有问题就把 passed 设为 true、issues 为空数组。description 必须描述这张图里实际看见的内容。`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseIssueKind(value: unknown): ArtifactRenderIssueKind {
  return typeof value === 'string' && ISSUE_KINDS.includes(value as ArtifactRenderIssueKind)
    ? value as ArtifactRenderIssueKind
    : 'overflow';
}

function parseSeverity(value: unknown): ArtifactRenderIssue['severity'] {
  return value === 'high' || value === 'low' || value === 'medium' ? value : 'medium';
}

function parsePageReview(text: string): { issues: Array<Omit<ArtifactRenderIssue, 'file' | 'page'>> } {
  const tryParse = (raw: string): unknown => {
    try { return JSON.parse(raw) as unknown; } catch { return undefined; }
  };
  let parsed: unknown = tryParse(text);
  if (parsed === undefined) {
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced) parsed = tryParse(fenced[1]);
  }
  if (parsed === undefined) {
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) parsed = tryParse(brace[0]);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.issues)) {
    return { issues: [] };
  }
  return {
    issues: parsed.issues.filter(isRecord).map((issue) => ({
      kind: parseIssueKind(issue.kind),
      description: String(issue.description || ''),
      severity: parseSeverity(issue.severity),
    })),
  };
}

async function defaultVlm(prompt: string, imagePath: string): Promise<string> {
  const { analyzeImageWithVision } = await import('../../services/desktop/visionAnalysisService');
  const analysis = await analyzeImageWithVision({
    imagePath,
    prompt,
    source: 'artifact-render-review',
  });
  return analysis ?? '';
}

export async function checkXlsxStructure(filePath: string): Promise<ArtifactRenderIssue[]> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    if (workbook.worksheets.length === 0) {
      return [{ file: filePath, page: 1, kind: 'overflow', description: '工作簿没有工作表', severity: 'high' }];
    }
    const issues: ArtifactRenderIssue[] = [];
    workbook.eachSheet((worksheet) => {
      const rows = worksheet.actualRowCount || worksheet.rowCount || 0;
      const cols = worksheet.actualColumnCount || worksheet.columnCount || 0;
      if (rows === 0 || cols === 0) {
        issues.push({
          file: filePath,
          page: 1,
          kind: 'overflow',
          description: `工作表「${worksheet.name}」行列维度为零（空表）`,
          severity: 'high',
        });
      }
    });
    return issues;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ file: filePath, page: 1, kind: 'overflow', description: `xlsx 无法打开: ${message}`, severity: 'high' }];
  }
}

async function rasterizeDeliverable(
  filePath: string,
  screenshotDir: string,
): Promise<string[]> {
  const ext = extensionOf(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const pdfPath = ext === 'pdf'
    ? filePath
    : convertOfficeToPdf(filePath, path.join(screenshotDir, '_pdf'));
  return rasterizePdfToImages(pdfPath, screenshotDir, baseName, {
    maxPages: ARTIFACT_RENDER_REVIEW.MAX_PAGES,
  });
}

export type ArtifactRenderReviewDeps = {
  vlm?: ArtifactRenderVlm;
  libreOfficeAvailable?: () => boolean;
  rasterize?: (filePath: string, screenshotDir: string) => Promise<string[]>;
  checkXlsx?: (filePath: string) => Promise<ArtifactRenderIssue[]>;
};

export async function reviewRenderableDeliverables(
  files: readonly string[],
  deps: ArtifactRenderReviewDeps = {},
): Promise<ArtifactRenderReviewStamp> {
  if (files.length === 0) {
    return { status: 'not_applicable', issues: [], filesReviewed: [] };
  }

  const libreOfficeAvailable = deps.libreOfficeAvailable ?? isLibreOfficeAvailable;
  const needsOffice = files.some((filePath) => extensionOf(filePath) !== 'pdf');
  if (needsOffice && !libreOfficeAvailable()) {
    logger.warn('LibreOffice not available, skipping visual review');
    return { status: 'skipped_no_libreoffice', issues: [], filesReviewed: [] };
  }

  const vlm = deps.vlm ?? defaultVlm;
  const rasterize = deps.rasterize ?? rasterizeDeliverable;
  const checkXlsx = deps.checkXlsx ?? checkXlsxStructure;
  const issues: ArtifactRenderIssue[] = [];
  const filesReviewed: string[] = [];
  let vlmCalls = 0;
  let vlmResponded = false;

  for (const filePath of files) {
    if (extensionOf(filePath) === 'xlsx') {
      issues.push(...await checkXlsx(filePath));
    }

    const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-render-review-'));
    try {
      const pages = await rasterize(filePath, screenshotDir);
      filesReviewed.push(filePath);
      for (let index = 0; index < pages.length; index += 1) {
        if (vlmCalls >= ARTIFACT_RENDER_REVIEW.MAX_VLM_CALLS_PER_DELIVERY) break;
        vlmCalls += 1;
        const pageNumber = index + 1;
        const response = await vlm(pageReviewPrompt(pageNumber, extensionOf(filePath)), pages[index]);
        if (!response.trim()) continue;
        vlmResponded = true;
        const parsed = parsePageReview(response);
        for (const issue of parsed.issues) {
          issues.push({ ...issue, file: filePath, page: pageNumber });
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`visual review rasterize failed: ${message}`);
      if (!libreOfficeAvailable() && extensionOf(filePath) !== 'pdf') {
        return { status: 'skipped_no_libreoffice', issues: [], filesReviewed };
      }
      issues.push({
        file: filePath,
        page: 1,
        kind: 'overflow',
        description: `渲染失败: ${message}`,
        severity: 'high',
      });
    } finally {
      fs.rmSync(screenshotDir, { recursive: true, force: true });
    }
    if (vlmCalls >= ARTIFACT_RENDER_REVIEW.MAX_VLM_CALLS_PER_DELIVERY) break;
  }

  const blocking = issues.filter((issue) =>
    issue.kind === 'overflow' || issue.kind === 'overlap' || issue.severity !== 'low');
  if (blocking.length > 0) {
    return { status: 'failed', issues, filesReviewed };
  }
  if (filesReviewed.length > 0 && vlmCalls > 0 && !vlmResponded) {
    logger.warn('VLM returned empty responses, skipping visual verification');
    return { status: 'skipped_no_vlm', issues, filesReviewed };
  }
  return { status: 'passed', issues, filesReviewed };
}

function buildVisualRepairPrompt(issues: readonly ArtifactRenderIssue[]): string {
  const lines = issues.map((issue, index) =>
    `${index + 1}. \`${issue.file}\` 第 ${issue.page} 页 [${issue.kind}/${issue.severity}]：${issue.description}`);
  return [
    '<artifact-render-review>',
    '交付物视觉审查未通过。请按页修复下面的版面问题，然后重新收尾：',
    ...lines,
    '优先处理溢出/截断，再处理重叠、挤压、低对比、模板残留。',
    '修完后不要在问题仍在的情况下再次声称已交付。',
    '</artifact-render-review>',
  ].join('\n');
}

function appendVisualFailureNote(content: string, issues: readonly ArtifactRenderIssue[]): string {
  const lines = issues.map((issue) =>
    `- ${path.basename(issue.file)} 第 ${issue.page} 页：${issue.description}（${issue.kind}）`);
  return [
    content,
    '',
    '---',
    '⚠️ 视觉审查未通过（已修 3 轮仍在）。本轮不标记为已验证。要继续的话请告诉我方向（例如：缩小字号 / 拆表 / 加宽页边）。',
    ...lines,
  ].join('\n');
}

export type ArtifactRenderReviewGateResult =
  | { action: 'pass'; content: string; stamp: ArtifactRenderReviewStamp }
  | { action: 'repair'; prompt: string; stamp: ArtifactRenderReviewStamp };

export async function runArtifactRenderReviewGate(input: {
  workingDirectory: string;
  messages: readonly Message[];
  declaredDeliverables?: DeclaredDeliverables;
  finalText: string;
  repairsUsed: number;
  nudgeManager?: { getModifiedFilesSince(timestamp: number): string[] };
  deps?: ArtifactRenderReviewDeps;
}): Promise<ArtifactRenderReviewGateResult> {
  const claims = collectDeliverableClaims({
    messages: input.messages,
    workingDirectory: input.workingDirectory,
    declaredDeliverables: input.declaredDeliverables,
    finalText: input.finalText,
    nudgeManager: input.nudgeManager,
  }).filter(isRenderableClaim);

  const stamp = await reviewRenderableDeliverables(
    claims.map((claim) => claim.resolved),
    input.deps,
  );

  if (stamp.status === 'not_applicable' || stamp.status === 'skipped_no_libreoffice' || stamp.status === 'skipped_no_vlm' || stamp.status === 'passed') {
    return { action: 'pass', content: input.finalText, stamp };
  }

  const blocking = stamp.issues.filter((issue) => needsRevision([issue]));
  if (blocking.length === 0) {
    return { action: 'pass', content: input.finalText, stamp };
  }
  if (input.repairsUsed < ARTIFACT_RENDER_REVIEW.MAX_REPAIR_ROUNDS) {
    return { action: 'repair', prompt: buildVisualRepairPrompt(blocking), stamp };
  }
  return { action: 'pass', content: appendVisualFailureNote(input.finalText, blocking), stamp };
}

export type DeliverableCloseGateResult =
  | { action: 'pass'; content: string }
  | { action: 'repair'; kind: 'disk' | 'visual'; prompt: string; tag: ContextInjectionSource; logMessage: string };

/** 落盘核对之后接渲染审查。messageProcessor 只调这一处，避免两套补轮分叉。 */
export async function applyDeliverableCloseGates(input: {
  workingDirectory: string;
  messages: readonly Message[];
  declaredDeliverables?: DeclaredDeliverables;
  finalText: string;
  diskRepairsUsed: number;
  visualRepairsUsed: number;
  nudgeManager?: { getModifiedFilesSince(timestamp: number): string[] };
  artifact?: { setRenderReview?(stamp: ArtifactRenderReviewStamp): void };
  deps?: ArtifactRenderReviewDeps;
}): Promise<DeliverableCloseGateResult> {
  const disk = runDeliverableDiskCheckGate({
    workingDirectory: input.workingDirectory,
    messages: input.messages,
    declaredDeliverables: input.declaredDeliverables,
    finalText: input.finalText,
    repairsUsed: input.diskRepairsUsed,
    nudgeManager: input.nudgeManager,
  });
  if (disk.action === 'repair') {
    return {
      action: 'repair',
      kind: 'disk',
      prompt: disk.prompt,
      tag: 'deliverable-disk-check',
      logMessage: '[DeliverableDiskCheck] deliverables not on disk, bounded repair round fed back',
    };
  }

  const visual = await runArtifactRenderReviewGate({
    workingDirectory: input.workingDirectory,
    messages: input.messages,
    declaredDeliverables: input.declaredDeliverables,
    finalText: disk.content,
    repairsUsed: input.visualRepairsUsed,
    nudgeManager: input.nudgeManager,
    deps: input.deps,
  });
  input.artifact?.setRenderReview?.(visual.stamp);
  if (visual.action === 'repair') {
    return {
      action: 'repair',
      kind: 'visual',
      prompt: visual.prompt,
      tag: 'artifact-render-review',
      logMessage: '[ArtifactRenderReview] visual issues, bounded repair round fed back',
    };
  }
  return { action: 'pass', content: visual.content };
}
