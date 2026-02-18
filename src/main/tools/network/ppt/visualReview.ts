// ============================================================================
// Visual Review - 截图 → VLM 审查 → 自动修正
// ============================================================================
// ⑧ 截图：LibreOffice headless .pptx → PDF → PNG
// ⑨ VLM 审查：逐页 image_analyze 审查
// ⑩ 自动修正：生成修正建议，最多 2 轮
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createLogger } from '../../../services/infra/logger';
import type { ReviewResult, FixSuggestion, VlmCallback, ReviewDimensionType } from './types';
import { REVIEW_DIMENSION_WEIGHTS } from './types';
import { LIBREOFFICE_SEARCH_PATHS, LIBREOFFICE_PATH_ENV, CONVERT_TIMEOUTS, PDF_RENDER } from './constants';

const logger = createLogger('VisualReview');

// ============================================================================
// ⑧ Screenshot Generation
// ============================================================================

/**
 * 检查 LibreOffice 是否可用
 */
export function isLibreOfficeAvailable(): boolean {
  try {
    // 优先使用环境变量指定的路径
    const envPath = process.env[LIBREOFFICE_PATH_ENV];
    if (envPath && fs.existsSync(envPath)) return true;

    for (const p of LIBREOFFICE_SEARCH_PATHS) {
      if (fs.existsSync(p)) return true;
    }
    // 尝试 which
    execSync('which soffice 2>/dev/null || which libreoffice 2>/dev/null', { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取 LibreOffice 可执行文件路径
 */
function getLibreOfficePath(): string {
  // 优先使用环境变量指定的路径
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

/**
 * 将 PPTX 转换为每页 PNG 截图
 *
 * 流程：PPTX → PDF (LibreOffice) → PNG (sips/convert)
 *
 * @param pptxPath - PPTX 文件路径
 * @param outputDir - 截图输出目录（默认同目录下 _screenshots/）
 * @returns 每页 PNG 文件路径数组
 */
export async function convertToScreenshots(
  pptxPath: string,
  outputDir?: string,
): Promise<string[]> {
  if (!fs.existsSync(pptxPath)) {
    throw new Error(`PPTX not found: ${pptxPath}`);
  }

  const soffice = getLibreOfficePath();
  const screenshotDir = outputDir || path.join(path.dirname(pptxPath), '_screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  // Step 1: PPTX → PDF
  const pdfDir = path.join(screenshotDir, '_pdf');
  if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
  }

  try {
    execSync(
      `"${soffice}" --headless --convert-to pdf --outdir "${pdfDir}" "${pptxPath}"`,
      { timeout: CONVERT_TIMEOUTS.PDF_CONVERT, encoding: 'utf8' }
    );
  } catch (err: any) {
    throw new Error(`LibreOffice conversion failed: ${err.message}`);
  }

  const baseName = path.basename(pptxPath, '.pptx');
  const pdfPath = path.join(pdfDir, `${baseName}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF not generated: ${pdfPath}`);
  }

  // Step 2: PDF → PNG per page (using sips on macOS or ImageMagick/poppler)
  const pngPaths = await pdfToImages(pdfPath, screenshotDir, baseName);
  logger.debug(`Generated ${pngPaths.length} screenshots`);

  return pngPaths;
}

/**
 * PDF → 每页 PNG
 * macOS 优先使用 automator/qlmanage，降级到 ImageMagick
 */
async function pdfToImages(
  pdfPath: string,
  outputDir: string,
  baseName: string,
): Promise<string[]> {
  // 尝试 poppler (pdftoppm) — 最可靠，输出 JPEG 减小体积
  try {
    execSync('which pdftoppm', { encoding: 'utf8' });
    execSync(
      `pdftoppm -jpeg -jpegopt quality=${PDF_RENDER.QUALITY} -r ${PDF_RENDER.DPI} "${pdfPath}" "${path.join(outputDir, baseName)}"`,
      { timeout: CONVERT_TIMEOUTS.PDFTOPPM, encoding: 'utf8' }
    );
    // pdftoppm 输出 baseName-1.jpg, baseName-2.jpg, ...
    const files = fs.readdirSync(outputDir)
      .filter(f => f.startsWith(baseName) && f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(outputDir, f));
    if (files.length > 0) return files;
  } catch { /* try next */ }

  // 尝试 ImageMagick (convert/magick)
  try {
    const magick = execSync('which magick 2>/dev/null || which convert 2>/dev/null', { encoding: 'utf8' }).trim();
    execSync(
      `"${magick}" -density ${PDF_RENDER.DPI} -quality ${PDF_RENDER.QUALITY} "${pdfPath}" "${path.join(outputDir, `${baseName}-%d.jpg`)}"`,
      { timeout: CONVERT_TIMEOUTS.IMAGEMAGICK, encoding: 'utf8' }
    );
    const files = fs.readdirSync(outputDir)
      .filter(f => f.startsWith(baseName) && f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(outputDir, f));
    if (files.length > 0) return files;
  } catch { /* try next */ }

  // 降级：macOS qlmanage 生成单页缩略图
  try {
    const outFile = path.join(outputDir, `${baseName}-preview.png`);
    execSync(
      `qlmanage -t -s ${PDF_RENDER.QLMANAGE_SIZE} -o "${outputDir}" "${pdfPath}" 2>/dev/null`,
      { timeout: CONVERT_TIMEOUTS.QLMANAGE, encoding: 'utf8' }
    );
    // qlmanage 输出 <filename>.pdf.png
    const qlFile = path.join(outputDir, `${path.basename(pdfPath)}.png`);
    if (fs.existsSync(qlFile)) {
      fs.renameSync(qlFile, outFile);
      return [outFile];
    }
  } catch { /* no fallback left */ }

  logger.warn('No PDF-to-image converter found (pdftoppm/magick/qlmanage)');
  return [];
}

// ============================================================================
// ⑨ VLM Review
// ============================================================================

/**
 * 审查单页幻灯片截图
 *
 * @param screenshotPath - PNG 截图路径
 * @param slideIndex - 页码（0-based）
 * @param modelCallback - VLM 回调（接收 prompt + 图片路径）
 */
export async function reviewSlide(
  screenshotPath: string,
  slideIndex: number,
  modelCallback: (prompt: string) => Promise<string>,
  vlmCallback?: VlmCallback,
): Promise<ReviewResult> {
  if (!fs.existsSync(screenshotPath)) {
    return { slideIndex, score: 3, issues: [], suggestions: ['截图不存在，跳过审查'] };
  }

  const prompt = `你是专业的演示文稿设计审查专家。请仔细观察这张幻灯片截图，从以下 8 个维度逐一评估。

## 评估维度（3 层 8 维度）

### Layer 1: 硬性规则（权重各 15%）

**D1 text_readability（文本可读性）**
- 5: 所有文本完整可见，文字与背景对比鲜明，字号层级清晰（标题 ≥ 28pt 效果，正文 ≥ 16pt 效果），行距舒适
- 4: 文本完整可见，对比度良好，字号差异合理但某处略小
- 3: 有轻微文字截断（≤1 处）或个别低对比度区域
- 2: 明显文字截断（2-3 处）或多处低对比度，正文字号过小
- 1: 大面积文字被遮挡/截断，对比度严重不足，无法正常阅读

**D2 layout_precision（布局精度）**
- 5: 无元素重叠，所有元素沿统一网格对齐，间距均匀一致
- 4: 无功能性重叠，对齐良好，间距基本均匀
- 3: 轻微装饰性重叠可接受，大部分元素对齐，间距有轻微不一致
- 2: 存在影响可读性的重叠，对齐混乱，间距不规律
- 1: 严重重叠遮挡内容，元素位置随意无规律

**D3 information_density（信息密度）**
- 5: 单页 ≤ 5 个信息点，留白充足（≥ 30%），内容有呼吸感
- 4: 单页 ≤ 7 个信息点，留白合理（≥ 25%），稍密但可接受
- 3: 单页 ≤ 9 个信息点，略显拥挤但信息可读
- 2: 信息点过多（10-15），明显过载，留白严重不足
- 1: 极度拥挤，几乎无留白，文字墙

### Layer 2: 视觉质量（权重各 12.5%）

**D4 visual_hierarchy（视觉层级）**
- 5: 视觉焦点明确（标题最突出），信息层级分明（标题 > 副标题 > 正文），眼动路径自然
- 4: 层级清晰但某一级别区分度稍弱
- 3: 有基本层级但区分不够鲜明，2 个元素权重相近
- 2: 层级模糊，难以判断阅读起点
- 1: 完全没有层级，所有元素权重相同

**D5 color_contrast（色彩与对比）**
- 5: 配色和谐，色彩数量控制（≤ 4 主色），强调色使用恰当
- 4: 配色基本和谐，偶有不够协调的组合
- 3: 配色中规中矩，某些颜色搭配生硬但不刺眼
- 2: 配色不协调，颜色过多或过于单调
- 1: 色彩刺眼/冲突严重，背景与文字难以区分

**D6 consistency（一致性与重复）**
- 5: 字体统一（≤ 2 字体族），配色一致，标题/正文位置固定，风格语言统一
- 4: 大部分页面风格统一，偶有 1 处轻微偏差
- 3: 整体风格基本统一但有 2-3 处不一致
- 2: 风格混乱，看起来像拼接自不同模板
- 1: 每页风格完全不同，毫无统一感
（注：此维度基于单页内部一致性评估，跨页一致性后续加入）

### Layer 3: 主观审美（权重各 7.5%）

**D7 composition（构图与平衡）**
- 5: 视觉重心稳定，元素分布均衡，空间利用合理，整体构图专业
- 4: 构图良好，某区域稍重但整体平衡
- 3: 构图基本可接受，但明显一侧偏重或失衡
- 2: 构图失衡，元素集中在某角落，大片空白与密集区域对比突兀
- 1: 完全没有构图意识，元素随意堆放

**D8 professional_polish（专业度）**
- 5: 像专业设计师作品，细节精致（阴影/圆角/间距统一），图片高质量
- 4: 接近专业水准，偶有小瑕疵
- 3: 中等水准，能传达信息但缺乏设计感
- 2: 明显业余，有低质量图片或粗糙排版
- 1: 极度粗糙，多处明显错误

## 评估流程
请对每个维度：(1) 先简述你观察到的具体现象 (2) 再给出 1-5 分

## 输出格式
返回 JSON（只返回 JSON，不要其他文字）：
{
  "score": 3.8,
  "issues": [
    {"type": "text_readability", "description": "右下角卡片内文字被截断约 2 行", "severity": "high", "fix": "缩短文字或减小 fontSize 2pt"},
    {"type": "color_contrast", "description": "灰色副标题在深灰背景上对比度不足", "severity": "medium", "fix": "将副标题颜色改为浅灰 #E0E0E0"}
  ],
  "suggestions": ["缩短右下角文字至 15 字以内", "提高副标题与背景的对比度"]
}

type: text_readability | layout_precision | information_density | visual_hierarchy | color_contrast | consistency | composition | professional_polish
severity: high（影响阅读/功能）| medium（影响美观）| low（微调建议）

score 字段为 8 个维度的加权平均分（权重：Layer1 各 15%，Layer2 各 12.5%，Layer3 各 7.5%）。
每个 issue 必须包含具体的 fix 建议。仅报告得分 < 4 的维度的问题。
幻灯片页码: ${slideIndex + 1}`;

  try {
    // 优先使用视觉模型回调（能真正"看"截图），否则降级到纯文本模型
    const response = vlmCallback
      ? await vlmCallback(prompt, screenshotPath)
      : await modelCallback(prompt);
    const parsed = parseReviewResponse(response);
    return { slideIndex, ...parsed };
  } catch (err: any) {
    logger.warn(`VLM review failed for slide ${slideIndex}: ${err.message}`);
    return { slideIndex, score: 3, issues: [], suggestions: [] };
  }
}

/**
 * 审查整个演示文稿
 *
 * @param pptxPath - PPTX 文件路径
 * @param modelCallback - VLM 回调
 * @returns 每页审查结果
 */
export async function reviewPresentation(
  pptxPath: string,
  modelCallback: (prompt: string) => Promise<string>,
  vlmCallback?: VlmCallback,
): Promise<ReviewResult[]> {
  if (!isLibreOfficeAvailable()) {
    logger.warn('LibreOffice not available, skipping visual review');
    return [];
  }

  const screenshots = await convertToScreenshots(pptxPath);
  if (screenshots.length === 0) {
    logger.warn('No screenshots generated, skipping review');
    return [];
  }

  // 逐页审查（串行 + 间隔 2s 避免代理限流）
  const results: ReviewResult[] = [];
  for (let i = 0; i < screenshots.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 2000));
    const result = await reviewSlide(screenshots[i], i, modelCallback, vlmCallback);
    results.push(result);
  }

  // 清理截图目录
  try {
    const screenshotDir = path.dirname(screenshots[0]);
    fs.rmSync(screenshotDir, { recursive: true, force: true });
  } catch { /* ignore cleanup errors */ }

  return results;
}

// ============================================================================
// ⑩ Auto-Fix Suggestions
// ============================================================================

/**
 * 根据审查结果生成修正建议
 */
export function generateFixSuggestions(results: ReviewResult[]): FixSuggestion[] {
  const suggestions: FixSuggestion[] = [];

  for (const result of results) {
    for (const issue of result.issues) {
      switch (issue.type) {
        case 'text_readability':
          suggestions.push({
            slideIndex: result.slideIndex,
            action: issue.severity === 'high' ? 'shorten_text' : 'reduce_font',
            details: issue.description,
          });
          break;
        case 'layout_precision':
          suggestions.push({
            slideIndex: result.slideIndex,
            action: 'redistribute',
            details: issue.description,
          });
          break;
        case 'information_density':
          suggestions.push({
            slideIndex: result.slideIndex,
            action: 'redistribute',
            details: issue.description,
          });
          break;
        case 'color_contrast':
          suggestions.push({
            slideIndex: result.slideIndex,
            action: 'adjust_color',
            details: issue.description,
          });
          break;
        case 'composition':
        case 'professional_polish':
          if (result.score < 3) {
            suggestions.push({
              slideIndex: result.slideIndex,
              action: 'change_layout',
              details: issue.description,
            });
          }
          break;
      }
    }
  }

  return suggestions;
}

/**
 * 计算审查总结
 */
export function summarizeReview(results: ReviewResult[]): {
  averageScore: number;
  totalIssues: number;
  highSeverityCount: number;
  needsRevision: boolean;
  hasCriticalDimension: boolean;
} {
  if (results.length === 0) {
    return { averageScore: 0, totalIssues: 0, highSeverityCount: 0, needsRevision: false, hasCriticalDimension: false };
  }

  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const highSeverity = results.reduce(
    (sum, r) => sum + r.issues.filter(i => i.severity === 'high').length,
    0
  );
  // 一票否决：任何页面得分 <= 1 表示有维度严重失败
  const hasCriticalDimension = results.some(r => r.score <= 1);

  return {
    averageScore: Math.round(avgScore * 10) / 10,
    totalIssues,
    highSeverityCount: highSeverity,
    hasCriticalDimension,
    needsRevision: avgScore < 3.5 || highSeverity > 0 || hasCriticalDimension,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function parseReviewResponse(text: string): Omit<ReviewResult, 'slideIndex'> {
  const defaultResult = { score: 3 as number, issues: [] as ReviewResult['issues'], suggestions: [] as string[] };

  try {
    const parsed = JSON.parse(text);
    return normalizeReviewResult(parsed);
  } catch { /* continue */ }

  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try {
      return normalizeReviewResult(JSON.parse(jsonMatch[1]));
    } catch { /* continue */ }
  }

  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return normalizeReviewResult(JSON.parse(braceMatch[0]));
    } catch { /* continue */ }
  }

  return defaultResult;
}

function normalizeReviewResult(raw: any): Omit<ReviewResult, 'slideIndex'> {
  const validTypes: ReviewDimensionType[] = [
    'text_readability', 'layout_precision', 'information_density',
    'visual_hierarchy', 'color_contrast', 'consistency',
    'composition', 'professional_polish',
  ];
  const validSeverities = ['high', 'medium', 'low'];

  const issues = Array.isArray(raw.issues) ? raw.issues
    .filter((i: any) => i && typeof i === 'object')
    .map((i: any) => {
      const type: ReviewDimensionType = validTypes.includes(i.type) ? i.type : 'professional_polish';
      return {
        type,
        description: String(i.description || ''),
        severity: (validSeverities.includes(i.severity) ? i.severity : 'medium') as 'high' | 'medium' | 'low',
        ...(i.fix ? { fix: String(i.fix) } : {}),
        weight: REVIEW_DIMENSION_WEIGHTS[type],
      };
    }) : [];

  return {
    score: typeof raw.score === 'number' ? Math.round(Math.min(5, Math.max(1, raw.score)) * 10) / 10 : 3,
    issues,
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.map(String) : [],
  };
}
