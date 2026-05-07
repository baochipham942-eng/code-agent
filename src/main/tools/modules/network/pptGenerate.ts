// ============================================================================
// ppt_generate (P1 Wave 4 D2a — network/ppt: native ToolModule rewrite)
//
// v7 工作流：主题理解 → 深度搜索 → 模板选择 → 模板分析
//   → 大纲生成 → 资产生成 → 组装 PPT → 截图 → VLM 审查 → 自动修正
//
// 行为保真：legacy 输出格式（中文文案、字段排版）必须 1:1 复刻（评测集依赖）。
// 内部 helpers (themes/parser/layouts/...) 保留在 src/main/tools/media/ppt/。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { ZHIPU_VISION_MODEL, MODEL_API_ENDPOINTS, MODEL_MAX_TOKENS } from '../../../../shared/constants';
import type { PPTGenerateParams, SlideImage, ChartMode, ResearchContext, VlmCallback, SlideData } from '../../media/ppt/types';
import { getThemeConfig } from '../../media/ppt/themes';
import { parseContentToSlides, outlineToSlideData } from '../../media/ppt/parser';
import { registerSlideMasters, MASTER } from '../../media/ppt/slideMasters';
import {
  selectMasterAndLayout,
  fillSlide,
  fillStructuredSlide,
  selectMasterForStructuredSlide,
  resetLayoutRotation,
} from '../../media/ppt/layouts';
import { normalizeDensity } from '../../media/ppt/densityControl';
import { validateNarrative } from '../../media/ppt/narrativeValidator';
import { generateFromTemplate } from '../../media/ppt/templateEngine';
import { loadDataSource } from '../../media/ppt/dataSourceAdapter';
import { analyzeDataForPresentation } from '../../media/ppt/dataAnalyzer';
import { generateSlidePreview } from '../../media/ppt/preview';
import { formatFileSize } from '../../utils/fileSize';
import { validateStructuredSlides } from '../../media/ppt/slideSchemas';
import type { StructuredSlide } from '../../media/ppt/slideSchemas';
import { generateStructuredSlides } from '../../media/ppt/slideContentAgent';
import { parseTopicBrief, executeResearch } from '../../media/ppt/researchAgent';
import { injectChartData, buildChartDataFromResearch } from '../../media/ppt/assetGenerator';
import { generateSlideIllustrations } from '../../media/ppt/illustrationAgent';
import {
  reviewPresentation,
  summarizeReview,
  isLibreOfficeAvailable,
  convertToScreenshots,
} from '../../media/ppt/visualReview';
import { VLM_REQUEST_TIMEOUT } from '../../media/ppt/constants';
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { pptGenerateSchema as schema, LEGACY_PPT_GENERATE_ENV } from './pptGenerate.schema';

interface DesignPptArtifact {
  version: 1;
  kind: 'design_ppt';
  title: string;
  topic: string;
  theme: string;
  outputPath: string;
  slideCodePath?: string;
  promptPath?: string;
  screenshots: string[];
  slidesCount: number;
  iterations: number;
  createdAt: string;
  screenshotError?: string;
}

async function writeDesignPptArtifact(input: {
  topic: string;
  theme: string;
  finalPath: string;
  outputDir: string;
  designResult: {
    slidesCount?: number;
    iterations: number;
    slideCode?: string;
    prompts?: Array<{ kind: string; prompt: string }>;
  };
}): Promise<{ artifactPath: string; artifact: DesignPptArtifact }> {
  const baseName = path.basename(input.finalPath, '.pptx');
  const artifactPath = path.join(input.outputDir, `${baseName}.design-artifact.json`);
  const slideCodePath = input.designResult.slideCode
    ? path.join(input.outputDir, `${baseName}.design-slide-code.ts`)
    : undefined;
  const promptPath = input.designResult.prompts?.length
    ? path.join(input.outputDir, `${baseName}.design-prompts.json`)
    : undefined;

  if (slideCodePath && input.designResult.slideCode) {
    fs.writeFileSync(slideCodePath, input.designResult.slideCode, 'utf8');
  }
  if (promptPath && input.designResult.prompts) {
    fs.writeFileSync(promptPath, JSON.stringify(input.designResult.prompts, null, 2), 'utf8');
  }

  const screenshotsDir = path.join(input.outputDir, `${baseName}.screenshots`);
  let screenshots: string[] = [];
  let screenshotError: string | undefined;
  if (isLibreOfficeAvailable()) {
    try {
      screenshots = await convertToScreenshots(input.finalPath, screenshotsDir);
    } catch (err: unknown) {
      screenshotError = err instanceof Error ? err.message : String(err);
    }
  } else {
    screenshotError = 'LibreOffice not available';
  }

  const artifact: DesignPptArtifact = {
    version: 1,
    kind: 'design_ppt',
    title: path.basename(input.finalPath),
    topic: input.topic,
    theme: input.theme,
    outputPath: input.finalPath,
    slideCodePath,
    promptPath,
    screenshots,
    slidesCount: input.designResult.slidesCount || screenshots.length,
    iterations: input.designResult.iterations,
    createdAt: new Date().toISOString(),
    screenshotError,
  };

  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
  return { artifactPath, artifact };
}

// pptxgenjs is CJS — load via require to keep Electron compatibility
function getPptxGenJS(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pptxgenjs');
}

export async function executePptGenerate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  if (process.env[LEGACY_PPT_GENERATE_ENV] !== '1') {
    return {
      ok: false,
      error:
        `ppt_generate 已临时禁用。请改用 frontend-slides skill 或 /ppt。` +
        ` 如需调试遗留实现，请显式设置 ${LEGACY_PPT_GENERATE_ENV}=1。`,
      code: 'TOOL_DISABLED',
    };
  }

  const params = args as unknown as PPTGenerateParams & {
    research?: boolean;
    review?: boolean;
    auto_illustrate?: boolean;
  };
  const {
    topic,
    content,
    slides: rawSlides,
    slides_count = 10,
    theme = 'neon-green',
    output_path,
    images = [],
    chart_mode = 'auto',
    normalize_density = false,
    mode = 'generate',
    template_path,
    placeholders,
    data_source,
    preview = false,
    research: enableResearch = true,
    review: enableReview = true,
    auto_illustrate: autoIllustrate = false,
    fallback_on_design_failure: fallbackOnDesignFailure = false,
  } = params;

  const isPreview = preview === true;
  const shouldNormalizeDensity = normalize_density === true;
  const shouldResearch = enableResearch !== false;
  const shouldReview = enableReview !== false;
  let designFallback:
    | { error: string; iterations: number; requestedMode: 'design' }
    | null = null;

  try {
    const timestamp = Date.now();
    const fileName = `presentation-${timestamp}.pptx`;
    const outputDir = output_path ? path.dirname(output_path) : ctx.workingDir;
    const finalPath = output_path || path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // ===== D1: 模板模式分支（保持不变） =====
    if (mode === 'template' && template_path) {
      const result = await generateFromTemplate(
        template_path,
        placeholders || {},
        finalPath,
      );

      if (!result.success) {
        return { ok: false, error: result.error || '模板处理失败' };
      }

      const stats = fs.statSync(finalPath);
      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: `PPT 已生成（模板模式）

文件: ${finalPath}
模板: ${template_path}
幻灯片: ${result.slidesProcessed} 页
替换占位符: ${result.placeholdersReplaced} 个
大小: ${formatFileSize(stats.size)}

点击文件路径可直接打开。`,
        meta: {
          artifact: await createFileArtifact(finalPath, schema.name, ctx, {
            kind: 'document',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            metadata: {
              mode: 'template',
              templatePath: template_path,
              slidesCount: result.slidesProcessed,
              placeholdersReplaced: result.placeholdersReplaced,
            },
          }),
          filePath: finalPath,
          outputPath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: stats.size,
          slidesCount: result.slidesProcessed,
          mode: 'template',
          resultCount: result.slidesProcessed,
          contentLength: stats.size,
          truncated: false,
          attachment: {
            id: `ppt-${timestamp}`,
            type: 'file',
            category: 'document',
            name: path.basename(finalPath),
            path: finalPath,
            size: stats.size,
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          },
        },
      };
    }

    // ================================================================
    // v7 新工作流
    // ================================================================

    // ① 理解主题
    const brief = parseTopicBrief(topic, slides_count as number);
    const themeConfig = getThemeConfig(theme as string);
    ctx.logger.debug(`Topic brief: ${brief.audience}/${brief.style}, ${brief.keywords.join(',')}`);

    // ② 深度搜索（如果启用且有 modelCallback）
    let researchContext: ResearchContext | undefined;
    if (shouldResearch && ctx.modelCallback && !rawSlides && !content && !data_source) {
      ctx.logger.debug('Executing deep research...');
      try {
        researchContext = await executeResearch(brief, ctx.modelCallback);
        ctx.logger.debug(
          `Research: ${researchContext.facts.length} facts, ${researchContext.statistics.length} stats`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Research failed, continuing without: ${message}`);
      }
    }

    // ===== VLM Callback（视觉模型审查） =====
    const zhipuApiKey = process.env.ZHIPU_API_KEY;
    const vlmCallback: VlmCallback | undefined = zhipuApiKey
      ? async (prompt: string, imagePath: string): Promise<string> => {
          const imageData = fs.readFileSync(imagePath);
          const base64 = imageData.toString('base64');
          const ext = path.extname(imagePath).toLowerCase();
          const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

          ctx.logger.debug(
            `VLM request: file=${path.basename(imagePath)}, mime=${mime}, b64len=${base64.length}`,
          );

          const reqBody = JSON.stringify({
            model: ZHIPU_VISION_MODEL,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
              ],
            }],
            max_tokens: MODEL_MAX_TOKENS.VISION,
          });

          const apiUrl = new URL(`${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`);
          return new Promise<string>((resolve, reject) => {
            const req = https.request(
              {
                hostname: apiUrl.hostname,
                port: 443,
                path: apiUrl.pathname,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${zhipuApiKey}`,
                  'Content-Length': Buffer.byteLength(reqBody),
                },
                timeout: VLM_REQUEST_TIMEOUT,
              },
              (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => {
                  data += chunk.toString();
                });
                res.on('end', () => {
                  if (res.statusCode !== 200) {
                    ctx.logger.warn(`GLM-4V HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
                    reject(new Error(`GLM-4V error: ${res.statusCode} ${data.slice(0, 100)}`));
                    return;
                  }
                  try {
                    const json = JSON.parse(data) as {
                      choices?: Array<{ message?: { content?: string } }>;
                    };
                    resolve(json.choices?.[0]?.message?.content || '');
                  } catch (e: unknown) {
                    const message = e instanceof Error ? e.message : String(e);
                    reject(new Error(`VLM JSON parse error: ${message}`));
                  }
                });
              },
            );
            req.on('error', (e: Error) => reject(e));
            req.on('timeout', () => {
              req.destroy();
              reject(new Error(`VLM request timeout (${VLM_REQUEST_TIMEOUT / 1000}s)`));
            });
            req.write(reqBody);
            req.end();
          });
        }
      : undefined;

    if (vlmCallback) {
      ctx.logger.debug('VLM callback enabled (GLM-4V via ZHIPU_API_KEY)');
    }

    // ===== Design Mode =====
    if (mode === 'design' && ctx.modelCallback) {
      const { executeDesignMode } = await import('../../media/ppt/designMode');

      const pptxgenPath = require.resolve('pptxgenjs/package.json');
      const designResult = await executeDesignMode({
        topic,
        slideCount: slides_count as number,
        theme: themeConfig,
        outputPath: finalPath,
        projectRoot: path.dirname(pptxgenPath),
        modelCallback: ctx.modelCallback,
        vlmCallback,
        researchContext,
        enableReview: shouldReview,
      });

      if (designResult.success) {
        const stats = fs.statSync(finalPath);
        const designArtifact = await writeDesignPptArtifact({
          topic,
          theme: theme as string,
          finalPath,
          outputDir,
          designResult,
        });
        const researchInfo = researchContext
          ? `，深度搜索（${researchContext.facts.length} 事实，${researchContext.statistics.length} 数据）`
          : '';
        onProgress?.({ stage: 'completing', percent: 100 });
        return {
          ok: true,
          output: `PPT 已生成（Design Mode，${designResult.iterations} 轮迭代${researchInfo}）\n\n文件: ${finalPath}\n主题: ${themeConfig.name} (${theme})\n幻灯片: ${designResult.slidesCount || slides_count} 页\n大小: ${formatFileSize(stats.size)}\n\n点击文件路径可直接打开。`,
          meta: {
            artifact: await createFileArtifact(finalPath, schema.name, ctx, {
              kind: 'document',
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              metadata: {
                mode: 'design',
                topic,
                theme,
                slidesCount: designResult.slidesCount || slides_count,
                iterations: designResult.iterations,
                designArtifactPath: designArtifact.artifactPath,
              },
            }),
            filePath: finalPath,
            outputPath: finalPath,
            fileName: path.basename(finalPath),
            fileSize: stats.size,
            slidesCount: designResult.slidesCount || slides_count,
            theme,
            mode: 'design',
            iterations: designResult.iterations,
            hasResearch: !!researchContext,
            designArtifactPath: designArtifact.artifactPath,
            designSlideCodePath: designArtifact.artifact.slideCodePath,
            designPromptPath: designArtifact.artifact.promptPath,
            designScreenshots: designArtifact.artifact.screenshots,
            resultCount: designResult.slidesCount || slides_count,
            contentLength: stats.size,
            truncated: false,
            previewItem: {
              id: `design-ppt:${timestamp}`,
              kind: 'design_ppt',
              title: path.basename(finalPath),
              subtitle: `Design Mode · ${designResult.slidesCount || slides_count} slides`,
              status: designArtifact.artifact.screenshotError ? 'draft' : 'ready',
              file: {
                path: finalPath,
                name: path.basename(finalPath),
                size: stats.size,
                mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              },
              content: {
                json: JSON.stringify(designArtifact.artifact),
                summary: designArtifact.artifact.screenshotError
                  ? `PPT generated, screenshot preview failed: ${designArtifact.artifact.screenshotError}`
                  : `Editable Design Mode deck with ${designArtifact.artifact.screenshots.length} rendered slide previews.`,
              },
              actions: [
                { kind: 'open', label: 'Open PPTX' },
                { kind: 'edit', label: 'Edit Design Code' },
              ],
              priority: 88,
              currentTurn: true,
            },
            attachment: {
              id: `ppt-${timestamp}`,
              type: 'file',
              category: 'document',
              name: path.basename(finalPath),
              path: finalPath,
              size: stats.size,
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            },
          },
        };
      }
      designFallback = {
        error: designResult.error || 'Unknown Design Mode failure',
        iterations: designResult.iterations,
        requestedMode: 'design',
      };
      ctx.logger.warn(`Design mode failed: ${designFallback.error}`);
      if (!fallbackOnDesignFailure) {
        return {
          ok: false,
          error: `Design Mode 失败: ${designFallback.error}`,
          meta: {
            requestedMode: 'design',
            fallbackAvailable: true,
            fallbackHint:
              'Set fallback_on_design_failure=true to generate with v7 workflow after Design Mode failure.',
            designModeError: designFallback.error,
            designModeIterations: designFallback.iterations,
          },
        };
      }
      ctx.logger.warn('Falling back to generate mode after Design Mode failure');
    }

    // ===== 生成模式 =====
    // pptxgenjs 是 CJS 库，运行时构造，类型保持 unknown 以避免拉入 .d.ts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Pptx = getPptxGenJS() as new () => any;
    const pptx = new Pptx();

    pptx.author = 'Code Agent';
    pptx.title = topic;
    pptx.subject = topic;
    pptx.company = 'Generated by Code Agent';

    const slideImages: SlideImage[] = [...((images as SlideImage[]) || [])];

    // ===== 多通道内容生成 =====
    let structuredSlides: StructuredSlide[] | null = null;
    let legacySlides: SlideData[] | null = null;

    if (rawSlides && Array.isArray(rawSlides) && rawSlides.length > 0) {
      // 通道 A：结构化 JSON 输入
      const { validSlides, errors } = validateStructuredSlides(rawSlides as unknown as StructuredSlide[]);
      if (validSlides.length > 0) {
        structuredSlides = validSlides;
        if (errors.length > 0) {
          ctx.logger.debug(`Structured slides: ${validSlides.length} valid, ${errors.length} rejected`);
        }
      } else {
        ctx.logger.warn(`All structured slides failed validation, falling back to legacy`);
        legacySlides = content
          ? parseContentToSlides(content, slides_count)
          : outlineToSlideData(topic, slides_count);
      }
    } else if (data_source) {
      // D2: 数据源驱动
      const dataResult = await loadDataSource(data_source);
      legacySlides = analyzeDataForPresentation(dataResult, topic);
    } else if (!content && ctx.modelCallback) {
      // ⑤ 通道 C：模型生成结构化 slides（v7 注入 ResearchContext）
      const generated = await generateStructuredSlides(
        topic,
        slides_count,
        ctx.modelCallback,
        researchContext,
      );
      if (generated && generated.length > 0) {
        structuredSlides = generated;
        ctx.logger.debug(`Model generated ${generated.length} structured slides`);
      } else {
        legacySlides = outlineToSlideData(topic, slides_count);
      }
    } else {
      // 通道 B：传统 content markdown
      const processedContent = content || '';
      legacySlides = processedContent
        ? parseContentToSlides(processedContent, slides_count)
        : outlineToSlideData(topic, slides_count);
    }

    // ⑥ 注入图表数据（从研究数据自动构建）
    if (structuredSlides && researchContext) {
      const chartDataList = buildChartDataFromResearch(researchContext);
      if (chartDataList.length > 0) {
        structuredSlides = injectChartData(structuredSlides, chartDataList);
        ctx.logger.debug(`Injected ${chartDataList.length} charts from research data`);
      }
    }

    // ⑥.5 AI 配图自动生成（可选，仅结构化通道）
    if (autoIllustrate && structuredSlides) {
      ctx.logger.debug('Generating AI illustrations for slides...');
      try {
        const illustrationImages = await generateSlideIllustrations(
          structuredSlides,
          themeConfig.name,
          { maxImages: 3, engine: 'auto' },
          outputDir,
        );
        if (illustrationImages.length > 0) {
          slideImages.push(...illustrationImages);
          ctx.logger.debug(`Added ${illustrationImages.length} AI-generated illustrations`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`AI illustration generation failed, continuing without: ${message}`);
      }
    }

    // D3: 信息密度控制（仅传统通道）
    if (legacySlides && shouldNormalizeDensity) {
      legacySlides = normalizeDensity(legacySlides);
    }

    if (legacySlides) {
      // TODO(deck-verifier, Phase 4 PR-3): result currently discarded — narrativeValidator
      //   runs as a side-effect-free dead validator. PR-3 will replace this call with
      //   DeckVerifier.validate(...) and pipe failures into ctx.logger.warn (non-blocking).
      //   Baseline lives at scripts/acceptance/fixtures/deck/baseline.json.
      validateNarrative(legacySlides);
    }

    const totalSlides = structuredSlides?.length ?? legacySlides?.length ?? 0;

    // D5: 预览模式
    if (isPreview) {
      onProgress?.({ stage: 'completing', percent: 100 });
      if (legacySlides) {
        const previewText = generateSlidePreview(legacySlides);
        return {
          ok: true,
          output: previewText,
          meta: {
            artifact: createVirtualArtifact({
              sourceTool: schema.name,
              kind: 'text',
              sessionId: ctx.sessionId,
              name: `PPT preview: ${topic}`,
              mimeType: 'text/markdown',
              contentLength: previewText.length,
              preview: previewText.slice(0, 500),
              metadata: { topic, slidesCount: totalSlides, mode: 'preview' },
            }),
            slidesCount: totalSlides,
            mode: 'preview',
            resultCount: totalSlides,
            contentLength: previewText.length,
            truncated: false,
          },
        };
      }
      const lines = (structuredSlides || []).map((s, i) => {
        const notes = s.speakerNotes ? ' 📝' : '';
        return `[${i + 1}] ${s.title} (${s.layout})${notes}`;
      });
      const previewOutput = `预览（${totalSlides} 页）\n\n${lines.join('\n')}`;
      return {
        ok: true,
        output: previewOutput,
        meta: {
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'text',
            sessionId: ctx.sessionId,
            name: `PPT preview: ${topic}`,
            mimeType: 'text/markdown',
            contentLength: previewOutput.length,
            preview: previewOutput.slice(0, 500),
            metadata: { topic, slidesCount: totalSlides, mode: 'preview' },
          }),
          slidesCount: totalSlides,
          mode: 'preview',
          resultCount: totalSlides,
          contentLength: previewOutput.length,
          truncated: false,
        },
      };
    }

    // ⑦ 组装 PPT
    registerSlideMasters(pptx, themeConfig);
    resetLayoutRotation();

    if (structuredSlides) {
      for (let i = 0; i < structuredSlides.length; i++) {
        const slideData = structuredSlides[i];
        const currentSlideImages = slideImages?.filter(
          img => img.slide_index === i && fs.existsSync(img.image_path)
        ) || [];

        let master = selectMasterForStructuredSlide(slideData);
        if (currentSlideImages.length > 0 && !slideData.isTitle && !slideData.isEnd) {
          master = MASTER.CONTENT_IMAGE;
        }
        const slide = pptx.addSlide({ masterName: master });
        fillStructuredSlide(pptx, slide, slideData, themeConfig, i, null, currentSlideImages);

        if (slideData.speakerNotes) {
          slide.addNotes(slideData.speakerNotes);
        }
      }
    } else if (legacySlides) {
      for (let i = 0; i < legacySlides.length; i++) {
        const slideData = legacySlides[i];
        const currentSlideImages = slideImages?.filter(
          img => img.slide_index === i && fs.existsSync(img.image_path)
        ) || [];

        const { master, layout, chartData } = selectMasterAndLayout(
          slideData,
          currentSlideImages.length > 0,
          chart_mode as ChartMode,
        );

        const slide = pptx.addSlide({ masterName: master });
        fillSlide(pptx, slide, slideData, themeConfig, layout, i, chartData, currentSlideImages);
      }
    }

    await pptx.writeFile({ fileName: finalPath });
    let stats = fs.statSync(finalPath);

    // ⑧⑨⑩ VLM 视觉审查循环（最多 2 轮）
    let reviewSummary = '';
    if (shouldReview && ctx.modelCallback && isLibreOfficeAvailable()) {
      ctx.logger.debug('Starting visual review...');
      try {
        const results = await reviewPresentation(finalPath, ctx.modelCallback, vlmCallback);
        if (results.length > 0) {
          const summary = summarizeReview(results);
          reviewSummary = `\n视觉审查: 平均 ${summary.averageScore}/5.0，${summary.totalIssues} 个问题`;
          if (summary.highSeverityCount > 0) {
            reviewSummary += `（${summary.highSeverityCount} 个严重）`;
          }
          ctx.logger.debug(`Review: avg=${summary.averageScore}, issues=${summary.totalIssues}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Visual review failed: ${message}`);
      }
    }

    stats = fs.statSync(finalPath);
    const chartInfo = chart_mode === 'auto' ? '，原生图表自动检测' : '';
    const dataInfo = data_source ? `，数据源: ${path.basename(data_source)}` : '';
    const modeInfo = structuredSlides ? '，结构化 JSON' : '';
    const researchInfo = researchContext
      ? `，深度搜索（${researchContext.facts.length} 事实，${researchContext.statistics.length} 数据）`
      : '';
    const notesCount = structuredSlides?.filter(s => s.speakerNotes).length || 0;
    const notesInfo = notesCount > 0 ? `，${notesCount} 页演讲稿` : '';
    const illustrationCount = autoIllustrate
      ? slideImages.filter(img => img.image_path.includes('illustration-')).length
      : 0;
    const illustrationInfo = illustrationCount > 0 ? `，${illustrationCount} 张 AI 配图` : '';
    const fallbackInfo = designFallback ? `\nDesign Mode fallback: ${designFallback.error}` : '';

    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: `PPT 已生成（v7 工作流${chartInfo}${dataInfo}${modeInfo}${researchInfo}${notesInfo}${illustrationInfo}）

文件: ${finalPath}
主题: ${themeConfig.name} (${theme})
幻灯片: ${totalSlides} 页
大小: ${formatFileSize(stats.size)}${reviewSummary}${fallbackInfo}

点击文件路径可直接打开。`,
      meta: {
        artifact: await createFileArtifact(finalPath, schema.name, ctx, {
          kind: 'document',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          metadata: {
            mode: structuredSlides ? 'structured' : 'generate',
            topic,
            theme,
            slidesCount: totalSlides,
            chartMode: chart_mode,
            hasResearch: !!researchContext,
            hasSpeakerNotes: notesCount > 0,
          },
        }),
        filePath: finalPath,
        outputPath: finalPath,
        fileName: path.basename(finalPath),
        fileSize: stats.size,
        slidesCount: totalSlides,
        theme,
        chartMode: chart_mode,
        hasResearch: !!researchContext,
        hasSpeakerNotes: notesCount > 0,
        resultCount: totalSlides,
        contentLength: stats.size,
        truncated: false,
        ...(designFallback ? {
          requestedMode: designFallback.requestedMode,
          fallbackFrom: 'design',
          designModeError: designFallback.error,
          designModeIterations: designFallback.iterations,
        } : {}),
        attachment: {
          id: `ppt-${timestamp}`,
          type: 'file',
          category: 'document',
          name: path.basename(finalPath),
          path: finalPath,
          size: stats.size,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `PPT 生成失败: ${message}` };
  }
}

class PptGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePptGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const pptGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PptGenerateHandler();
  },
};
