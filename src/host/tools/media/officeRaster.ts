// ============================================================================
// Office rasterization — LibreOffice → PDF → per-page JPEG
// Shared by PPT visualReview and docx/pdf/xlsx artifact render review.
// pdftoppm stays an independent-process sidecar (ADR-040 C2a).
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { resolveHelperBinary } from '../../runtime/runtimeAssetResolver';
import { LIBREOFFICE_SEARCH_PATHS, LIBREOFFICE_PATH_ENV, CONVERT_TIMEOUTS, PDF_RENDER } from './ppt/constants';

export function isLibreOfficeAvailable(): boolean {
  try {
    const envPath = process.env[LIBREOFFICE_PATH_ENV];
    if (envPath && fs.existsSync(envPath)) return true;

    for (const p of LIBREOFFICE_SEARCH_PATHS) {
      if (fs.existsSync(p)) return true;
    }
    execSync('which soffice 2>/dev/null || which libreoffice 2>/dev/null', { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function getLibreOfficePath(): string {
  const envPath = process.env[LIBREOFFICE_PATH_ENV];
  if (envPath && fs.existsSync(envPath)) return envPath;

  for (const p of LIBREOFFICE_SEARCH_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execSync('which soffice 2>/dev/null || which libreoffice 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`LibreOffice not found. Install: brew install --cask libreoffice, or set ${LIBREOFFICE_PATH_ENV} env var`);
  }
}

/** 从页图文件名尾部抽页码：`deck-7.jpg` → 7、`deck-07.jpg` → 7。抽不到的排到末尾。 */
function pageNumberOf(file: string): number {
  const match = file.match(/-(\d+)\.jpg$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pageImagePattern(baseName: string): RegExp {
  return new RegExp(`^${escapeRegExp(baseName)}-\\d+\\.jpg$`);
}

export function clearPageImages(outputDir: string, baseName: string): void {
  const pattern = pageImagePattern(baseName);
  for (const file of fs.readdirSync(outputDir)) {
    if (pattern.test(file)) {
      fs.rmSync(path.join(outputDir, file), { force: true });
    }
  }
}

/**
 * 收集 outputDir 下属于 baseName 的页图，按文件名尾部页码**数值**定序。
 *
 * 必须数值定序而非字符串定序：pdftoppm 补零（`deck-01`..`deck-13`）时字符串序恰好
 * 正确，但 ImageMagick `%d` 不补零（`deck-0`..`deck-12`），字符串序会错成
 * 0,1,10,11,12,2,3,...——13 页实测得到页序 1,2,11,12,13,3,4,...。这里的数组下标
 * 直接作为 slideIndex 喂给 VLM（见 reviewPresentation），错序 = 审查结论和修正
 * 建议整体挂到错误页码上，且全程无报错。
 */
export function collectPageImages(outputDir: string, baseName: string): string[] {
  const pattern = pageImagePattern(baseName);
  return fs.readdirSync(outputDir)
    .filter(f => pattern.test(f))
    .sort((a, b) => pageNumberOf(a) - pageNumberOf(b) || a.localeCompare(b))
    .map(f => path.join(outputDir, f));
}

/**
 * 解析 pdftoppm — 优先随包的 sidecar（scripts/poppler/bin/pdftoppm，见 fetch-poppler.sh），
 * 回落到系统 PATH。
 *
 * 随包优先是为了消灭「用户机上没装 poppler → 整份 deck 只出 1 张 qlmanage 缩略图 →
 * 第 2 页起根本选不了」这条降级（ADR-040 D3）。开发机上通常两者都有，此时用随包的
 * 那份，保证开发看到的行为与用户一致。
 */
export function resolvePdftoppm(): string | null {
  const bundled = resolveHelperBinary(path.join('poppler', 'bin', 'pdftoppm'));
  if (bundled && fs.existsSync(bundled)) return bundled;
  try {
    return execSync('which pdftoppm', { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export function convertOfficeToPdf(inputPath: string, pdfDir: string): string {
  if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
  }
  const soffice = getLibreOfficePath();
  try {
    execSync(
      `"${soffice}" --headless --convert-to pdf --outdir "${pdfDir}" "${inputPath}"`,
      { timeout: CONVERT_TIMEOUTS.PDF_CONVERT, encoding: 'utf8' }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LibreOffice conversion failed: ${message}`, { cause: err });
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const pdfPath = path.join(pdfDir, `${baseName}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF not generated: ${pdfPath}`);
  }
  return pdfPath;
}

export interface RasterizePdfOptions {
  /** PPT 传入幻灯片数：对不上就走下一条降级。文档审查可省略。 */
  expectedPageCount?: number;
  /** 最多保留前 N 页（文档审查成本护栏）；PPT 不传。 */
  maxPages?: number;
}

/**
 * PDF → 每页 JPEG。优先 poppler(pdftoppm)，降级 ImageMagick，最后 qlmanage 单页。
 */
export async function rasterizePdfToImages(
  pdfPath: string,
  outputDir: string,
  baseName: string,
  options: RasterizePdfOptions = {},
): Promise<string[]> {
  const expectedPageCount = options.expectedPageCount;
  const maxPages = options.maxPages;
  const accept = (files: string[]): string[] | undefined => {
    const sliced = typeof maxPages === 'number' ? files.slice(0, maxPages) : files;
    if (typeof expectedPageCount === 'number') {
      return sliced.length === expectedPageCount ? sliced : undefined;
    }
    return sliced.length > 0 ? sliced : undefined;
  };

  try {
    const pdftoppm = resolvePdftoppm();
    if (!pdftoppm) throw new Error('pdftoppm not found');
    // PPT 路径不传 maxPages，命令串与抽取前完全一致（poppler 门扫 `"${pdfPath}"`）。
    const pageRange = typeof maxPages === 'number' && expectedPageCount === undefined
      ? ` -f 1 -l ${maxPages}`
      : '';
    execSync(
      `"${pdftoppm}" -jpeg -jpegopt quality=${PDF_RENDER.QUALITY} -r ${PDF_RENDER.DPI}${pageRange} "${pdfPath}" "${path.join(outputDir, baseName)}"`,
      { timeout: CONVERT_TIMEOUTS.PDFTOPPM, encoding: 'utf8' }
    );
    const files = collectPageImages(outputDir, baseName);
    const accepted = accept(files);
    if (accepted) return accepted;
  } catch { /* try next */ }
  clearPageImages(outputDir, baseName);

  try {
    const magick = execSync('which magick 2>/dev/null || which convert 2>/dev/null', { encoding: 'utf8' }).trim();
    execSync(
      `"${magick}" -density ${PDF_RENDER.DPI} -quality ${PDF_RENDER.QUALITY} "${pdfPath}" "${path.join(outputDir, `${baseName}-%d.jpg`)}"`,
      { timeout: CONVERT_TIMEOUTS.IMAGEMAGICK, encoding: 'utf8' }
    );
    const files = collectPageImages(outputDir, baseName);
    const accepted = accept(files);
    if (accepted) return accepted;
  } catch { /* try next */ }
  clearPageImages(outputDir, baseName);

  try {
    const outFile = path.join(outputDir, `${baseName}-preview.png`);
    execSync(
      `qlmanage -t -s ${PDF_RENDER.QLMANAGE_SIZE} -o "${outputDir}" "${pdfPath}" 2>/dev/null`,
      { timeout: CONVERT_TIMEOUTS.QLMANAGE, encoding: 'utf8' }
    );
    const qlFile = path.join(outputDir, `${path.basename(pdfPath)}.png`);
    if (fs.existsSync(qlFile)) {
      fs.renameSync(qlFile, outFile);
      if (expectedPageCount === 1 || (expectedPageCount === undefined && (maxPages ?? 1) >= 1)) {
        return [outFile];
      }
      fs.rmSync(outFile, { force: true });
    }
  } catch { /* no fallback left */ }

  throw new Error(`Screenshot rendering failed: expected ${expectedPageCount ?? 'at least 1'} pages`);
}
