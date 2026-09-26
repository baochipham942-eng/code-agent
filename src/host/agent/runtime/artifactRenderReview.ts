// ============================================================================
// Artifact Render Review — docx/pdf/xlsx 交付前渲染审查
//
// 接入点选 deliverableDiskCheck 的有界补轮（messageProcessor 落库前）：
// turnOutcomeStamp 是收尾侧账、不能回喂模型，修 3 轮必须走补轮闸。
// LibreOffice / VLM / 栅格化工具链不可用时跳过审查并盖「未做视觉验证」，
// 不把 skipped 当成通过，也不把基础设施失败当成版面问题去补轮。
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
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
  type DeliverableDiskCheckResult,
} from './deliverableDiskCheck';
import type { ArtifactRenderReviewStamp, DeclaredDeliverables } from './artifactState';

const logger = createLogger('ArtifactRenderReview');

const RENDERABLE = new Set<string>(ARTIFACT_RENDER_REVIEW.RENDERABLE_EXTENSIONS);

const SKIPPED_STATUSES: ReadonlySet<ArtifactRenderReviewStatus> = new Set([
  'skipped_no_libreoffice',
  'skipped_no_vlm',
  'skipped_render_failed',
]);

type ArtifactRenderIssueKind =
  | 'overflow'
  | 'overlap'
  | 'cramped'
  | 'low_contrast'
  | 'template_residue'
  | 'other';

type ArtifactRenderIssue = {
  file: string;
  page: number;
  kind: ArtifactRenderIssueKind;
  description: string;
  severity: 'high' | 'medium' | 'low';
};

type ArtifactRenderReviewStatus = ArtifactRenderReviewStamp['status'];

type ArtifactRenderVlm = (prompt: string, imagePath: string) => Promise<string>;

const ISSUE_KINDS: ArtifactRenderIssueKind[] = [
  'overflow', 'overlap', 'cramped', 'low_contrast', 'template_residue', 'other',
];

function extensionOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function isRenderableClaim(claim: DeliverableClaim): boolean {
  return RENDERABLE.has(extensionOf(claim.resolved));
}

export function formatVisualReviewProblems(stamp: ArtifactRenderReviewStamp): string[] {
  if (SKIPPED_STATUSES.has(stamp.status)) {
    return ['VISUAL_REVIEW_SKIPPED: 未做视觉验证'];
  }
  return stamp.issues.map((issue) =>
    `VISUAL_REVIEW_ISSUE: ${issue.file} p.${issue.page} ${issue.kind}: ${issue.description}`);
}

function needsRevision(issues: readonly ArtifactRenderIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'high' || issue.severity === 'medium');
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name) : '';
  const code = 'code' in error ? error.code : undefined;
  return name === 'AbortError' || code === 'ABORT_ERR';
}

function isUsableAbortSignal(signal: unknown): signal is AbortSignal {
  return Boolean(
    signal
    && typeof signal === 'object'
    && 'aborted' in signal
    && typeof (signal as AbortSignal).addEventListener === 'function',
  );
}

function abortError(): Error {
  const error = new Error('visual review aborted');
  error.name = 'AbortError';
  return error;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
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
    : 'other';
}

function parseSeverity(value: unknown): ArtifactRenderIssue['severity'] {
  return value === 'high' || value === 'low' || value === 'medium' ? value : 'medium';
}

function parsePageReview(text: string): { parsed: boolean; issues: Array<Omit<ArtifactRenderIssue, 'file' | 'page'>> } {
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
    return { parsed: false, issues: [] };
  }
  return {
    parsed: true,
    issues: parsed.issues.filter(isRecord).map((issue) => ({
      kind: parseIssueKind(issue.kind),
      description: String(issue.description || ''),
      severity: parseSeverity(issue.severity),
    })),
  };
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
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

function sheetHasExcelJsVisuals(worksheet: ExcelJS.Worksheet): boolean | 'unknown' {
  try {
    if (worksheet.getImages().length > 0) return true;
    const backgroundId = worksheet.getBackgroundImageId();
    if (typeof backgroundId === 'string' && backgroundId.length > 0) return true;
    const media = worksheet.model?.media;
    if (Array.isArray(media) && media.length > 0) return true;
    return false;
  } catch {
    return 'unknown';
  }
}

async function sheetHasDrawingOrChart(filePath: string, worksheet: ExcelJS.Worksheet): Promise<boolean | 'unknown'> {
  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const rels = zip.file(`xl/worksheets/_rels/sheet${worksheet.id}.xml.rels`);
    if (!rels) return false;
    const xml = await rels.async('string');
    return /(?:drawings|charts)\//i.test(xml);
  } catch {
    return 'unknown';
  }
}

async function checkXlsxStructure(filePath: string): Promise<ArtifactRenderIssue[]> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    if (workbook.worksheets.length === 0) {
      return [{ file: filePath, page: 1, kind: 'overflow', description: '工作簿没有工作表', severity: 'high' }];
    }
    const issues: ArtifactRenderIssue[] = [];
    for (const worksheet of workbook.worksheets) {
      const rows = worksheet.actualRowCount || worksheet.rowCount || 0;
      const cols = worksheet.actualColumnCount || worksheet.columnCount || 0;
      if (rows !== 0 && cols !== 0) continue;
      const excelVisuals = sheetHasExcelJsVisuals(worksheet);
      if (excelVisuals !== false) continue;
      const drawings = await sheetHasDrawingOrChart(filePath, worksheet);
      if (drawings !== false) continue;
      issues.push({
        file: filePath,
        page: 1,
        kind: 'overflow',
        description: `工作表「${worksheet.name}」行列维度为零（空表）`,
        severity: 'high',
      });
    }
    return issues;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ file: filePath, page: 1, kind: 'overflow', description: `xlsx 无法打开: ${message}`, severity: 'high' }];
  }
}

async function rasterizeDeliverable(
  filePath: string,
  screenshotDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted?.();
  const ext = extensionOf(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const pdfPath = ext === 'pdf'
    ? filePath
    : await convertOfficeToPdf(filePath, path.join(screenshotDir, '_pdf'), signal);
  return rasterizePdfToImages(pdfPath, screenshotDir, baseName, {
    maxPages: ARTIFACT_RENDER_REVIEW.MAX_PAGES,
    signal,
  });
}

export type ArtifactRenderReviewDeps = {
  vlm?: ArtifactRenderVlm;
  libreOfficeAvailable?: () => boolean;
  rasterize?: (filePath: string, screenshotDir: string, signal?: AbortSignal) => Promise<string[]>;
  checkXlsx?: (filePath: string) => Promise<ArtifactRenderIssue[]>;
  abortSignal?: AbortSignal;
  vlmCallsUsed?: number;
};

function stampOf(
  status: ArtifactRenderReviewStatus,
  issues: ArtifactRenderIssue[],
  filesReviewed: string[],
  vlmCallsUsed: number,
): ArtifactRenderReviewStamp {
  return { status, issues, filesReviewed, vlmCallsUsed };
}

async function reviewRenderableDeliverables(
  files: readonly string[],
  deps: ArtifactRenderReviewDeps = {},
): Promise<ArtifactRenderReviewStamp> {
  const existingFiles = files.filter(isRegularFile);
  const priorCalls = deps.vlmCallsUsed ?? 0;
  if (existingFiles.length === 0) {
    return stampOf('not_applicable', [], [], priorCalls);
  }

  const abortSignal = isUsableAbortSignal(deps.abortSignal) ? deps.abortSignal : undefined;
  const libreOfficeAvailable = deps.libreOfficeAvailable ?? isLibreOfficeAvailable;
  const needsOffice = existingFiles.some((filePath) => extensionOf(filePath) !== 'pdf');
  if (needsOffice && !libreOfficeAvailable()) {
    logger.warn('LibreOffice not available, skipping visual review');
    return stampOf('skipped_no_libreoffice', [], [], priorCalls);
  }

  const vlm = deps.vlm ?? defaultVlm;
  const rasterize = deps.rasterize ?? rasterizeDeliverable;
  const checkXlsx = deps.checkXlsx ?? checkXlsxStructure;
  const issues: ArtifactRenderIssue[] = [];
  const filesReviewed: string[] = [];
  let vlmCalls = 0;
  let vlmResponded = false;
  let renderFailed = false;
  let aborted = false;
  const turnBudget = ARTIFACT_RENDER_REVIEW.MAX_VLM_CALLS_PER_TURN;
  const deliveryBudget = ARTIFACT_RENDER_REVIEW.MAX_VLM_CALLS_PER_DELIVERY;

  const remainingTurn = (): number => Math.max(0, turnBudget - priorCalls - vlmCalls);
  const remainingDelivery = (): number => Math.max(0, deliveryBudget - vlmCalls);

  fileLoop: for (const filePath of existingFiles) {
    if (abortSignal?.aborted) {
      aborted = true;
      break;
    }
    if (extensionOf(filePath) === 'xlsx') {
      issues.push(...await checkXlsx(filePath));
    }

    const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-render-review-'));
    try {
      const pages = await rasterize(filePath, screenshotDir, abortSignal);
      filesReviewed.push(filePath);
      for (let index = 0; index < pages.length; index += 1) {
        if (abortSignal?.aborted) {
          aborted = true;
          break fileLoop;
        }
        if (remainingTurn() <= 0 || remainingDelivery() <= 0) break;
        vlmCalls += 1;
        const pageNumber = index + 1;
        const response = abortSignal
          ? await Promise.race([
            vlm(pageReviewPrompt(pageNumber, extensionOf(filePath)), pages[index]),
            waitForAbort(abortSignal),
          ])
          : await vlm(pageReviewPrompt(pageNumber, extensionOf(filePath)), pages[index]);
        if (!response.trim()) continue;
        const parsed = parsePageReview(response);
        if (!parsed.parsed) continue;
        vlmResponded = true;
        for (const issue of parsed.issues) {
          issues.push({ ...issue, file: filePath, page: pageNumber });
        }
      }
    } catch (error: unknown) {
      if (isAbortError(error) || abortSignal?.aborted) {
        aborted = true;
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`visual review rasterize failed: ${message}`);
      renderFailed = true;
    } finally {
      fs.rmSync(screenshotDir, { recursive: true, force: true });
    }
    if (remainingTurn() <= 0 || remainingDelivery() <= 0) break;
  }

  const used = priorCalls + vlmCalls;
  if (aborted && !needsRevision(issues) && !vlmResponded) {
    return stampOf(renderFailed ? 'skipped_render_failed' : 'skipped_no_vlm', [], filesReviewed, used);
  }
  if (renderFailed && !vlmResponded && !needsRevision(issues)) {
    return stampOf('skipped_render_failed', [], filesReviewed, used);
  }
  if (needsRevision(issues)) {
    return stampOf('failed', issues, filesReviewed, used);
  }
  if (filesReviewed.length > 0 && vlmCalls > 0 && !vlmResponded) {
    logger.warn('VLM returned empty responses, skipping visual verification');
    return stampOf('skipped_no_vlm', issues, filesReviewed, used);
  }
  return stampOf('passed', issues, filesReviewed, used);
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

type ArtifactRenderReviewGateResult =
  | { action: 'pass'; content: string; stamp: ArtifactRenderReviewStamp }
  | { action: 'repair'; prompt: string; stamp: ArtifactRenderReviewStamp };

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

async function runArtifactRenderReviewGate(input: {
  workingDirectory: string;
  messages: readonly Message[];
  declaredDeliverables?: DeclaredDeliverables;
  finalText: string;
  repairsUsed: number;
  nudgeManager?: { getModifiedFilesSince(timestamp: number): string[] };
  previousStamp?: ArtifactRenderReviewStamp;
  abortSignal?: AbortSignal;
  deps?: ArtifactRenderReviewDeps;
}): Promise<ArtifactRenderReviewGateResult> {
  const claims = collectDeliverableClaims({
    messages: input.messages,
    workingDirectory: input.workingDirectory,
    declaredDeliverables: input.declaredDeliverables,
    finalText: input.finalText,
    nudgeManager: input.nudgeManager,
  }).filter(isRenderableClaim);

  const claimedFiles = claims.map((claim) => claim.resolved);
  const previousIssues = input.repairsUsed > 0 ? (input.previousStamp?.issues ?? []) : [];
  const files = previousIssues.length > 0
    ? uniquePaths(previousIssues.map((issue) => issue.file))
    : claimedFiles;

  const priorCalls = input.previousStamp?.vlmCallsUsed ?? input.deps?.vlmCallsUsed ?? 0;
  const abortSignal = isUsableAbortSignal(input.abortSignal)
    ? input.abortSignal
    : input.deps?.abortSignal;
  const stamp = await reviewRenderableDeliverables(files, {
    ...input.deps,
    abortSignal,
    vlmCallsUsed: priorCalls,
  });

  if (abortSignal?.aborted) {
    return { action: 'pass', content: input.finalText, stamp };
  }
  if (stamp.status === 'not_applicable' || SKIPPED_STATUSES.has(stamp.status) || stamp.status === 'passed') {
    return { action: 'pass', content: input.finalText, stamp };
  }

  const blocking = stamp.issues.filter((issue) => needsRevision([issue]));
  if (blocking.length === 0) {
    return { action: 'pass', content: input.finalText, stamp };
  }
  const budgetLeft = (stamp.vlmCallsUsed ?? 0) < ARTIFACT_RENDER_REVIEW.MAX_VLM_CALLS_PER_TURN;
  if (input.repairsUsed < ARTIFACT_RENDER_REVIEW.MAX_REPAIR_ROUNDS && budgetLeft) {
    return { action: 'repair', prompt: buildVisualRepairPrompt(blocking), stamp };
  }
  return { action: 'pass', content: appendVisualFailureNote(input.finalText, blocking), stamp };
}

export type DeliverableCloseGateResult =
  | { action: 'pass'; content: string }
  | {
    action: 'repair';
    kind: 'disk' | 'visual';
    prompt: string;
    tag: ContextInjectionSource;
    logMessage: string;
    missing?: string[];
  };

/** 落盘核对之后接渲染审查。messageProcessor 只调这一处，避免两套补轮分叉。 */
export async function applyDeliverableCloseGates(input: {
  workingDirectory: string;
  messages: readonly Message[];
  declaredDeliverables?: DeclaredDeliverables;
  finalText: string;
  diskRepairsUsed: number;
  visualRepairsUsed: number;
  nudgeManager?: { getModifiedFilesSince(timestamp: number): string[] };
  artifact?: {
    setRenderReview?(stamp: ArtifactRenderReviewStamp): void;
    readonly renderReview?: ArtifactRenderReviewStamp;
    setLastDeliverableCheck?(result: DeliverableDiskCheckResult, checkedAtMs: number): void;
  };
  abortSignal?: AbortSignal;
  deps?: ArtifactRenderReviewDeps;
}): Promise<DeliverableCloseGateResult> {
  const disk = await runDeliverableDiskCheckGate({
    workingDirectory: input.workingDirectory,
    messages: input.messages,
    declaredDeliverables: input.declaredDeliverables,
    finalText: input.finalText,
    repairsUsed: input.diskRepairsUsed,
    nudgeManager: input.nudgeManager,
    artifact: input.artifact,
  });
  if (disk.action === 'repair') {
    return {
      action: 'repair',
      kind: 'disk',
      prompt: disk.prompt,
      tag: 'deliverable-disk-check',
      logMessage: '[DeliverableDiskCheck] deliverables not on disk, bounded repair round fed back',
      missing: disk.missing.map((item) => item.claim.resolved),
    };
  }

  const visual = await runArtifactRenderReviewGate({
    workingDirectory: input.workingDirectory,
    messages: input.messages,
    declaredDeliverables: input.declaredDeliverables,
    finalText: disk.content,
    repairsUsed: input.visualRepairsUsed,
    nudgeManager: input.nudgeManager,
    previousStamp: input.artifact?.renderReview,
    abortSignal: input.abortSignal,
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
