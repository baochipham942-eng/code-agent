// ============================================================================
// PPT Generate Tool - v7 模块化入口
// 10 步工作流：主题理解 → 深度搜索 → 模板选择 → 模板分析
//   → 大纲生成 → 资产生成 → 组装 PPT → 截图 → VLM 审查 → 自动修正
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { PPTGenerateParams, SlideImage, ChartMode, ResearchContext, VlmCallback } from './types';
import { ZHIPU_VISION_MODEL, MODEL_API_ENDPOINTS, MODEL_MAX_TOKENS } from '../../../../shared/constants';
import { getThemeConfig } from './themes';
import { parseContentToSlides, generatePlaceholderSlides, outlineToSlideData } from './parser';
import { registerSlideMasters, MASTER } from './slideMasters';
import { selectMasterAndLayout, fillSlide, fillStructuredSlide, selectMasterForStructuredSlide, resetLayoutRotation } from './layouts';
import { normalizeDensity } from './densityControl';
import { validateNarrative } from './narrativeValidator';
import { generateFromTemplate } from './templateEngine';
import { loadDataSource } from './dataSourceAdapter';
import { analyzeDataForPresentation } from './dataAnalyzer';
import { generateSlidePreview } from './preview';
import { formatFileSize } from '../utils';
import { validateStructuredSlides } from './slideSchemas';
import type { StructuredSlide } from './slideSchemas';
import { getLayoutSchemaDescription } from './slideSchemas';
import { generateStructuredSlides } from './slideContentAgent';
import { parseTopicBrief, executeResearch } from './researchAgent';
import { injectChartData, buildChartDataFromResearch } from './assetGenerator';
import { generateSlideIllustrations } from './illustrationAgent';
import { reviewPresentation, summarizeReview, isLibreOfficeAvailable } from './visualReview';
import { createLogger } from '../../../services/infra/logger';
import { VLM_REQUEST_TIMEOUT } from './constants';

const logger = createLogger('PPTGenerate');


// Use require for pptxgenjs (CJS compatible with Electron)
function getPptxGenJS() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const PptxGenJS = require('pptxgenjs');
  return PptxGenJS;
}

export const pptGenerateTool: Tool = {
  name: 'ppt_generate',
  description: `生成研究驱动、设计师品质的 PowerPoint 演示文稿（v7 工作流）。

**v7 新特性：**
- 自动深度搜索：每次生成前自动 web_search 获取最新数据，确保内容有真实数据支撑
- SCQA 叙事框架：麦肯锡金字塔结构（背景→矛盾→方案→行动号召）
- Action Title：标题是结论而非主题标签
- Speaker Notes：每页自动生成演讲者口述稿
- VLM 视觉审查：截图后逐页审查文字溢出/对比度/美观度（需安装 LibreOffice）

**输入方式：**
1. **仅 topic**（推荐）：自动搜索+生成，一步到位
2. **slides JSON**：结构化输入，精确控制每页
3. **content Markdown**：向后兼容

**可用布局：** stats、cards-2、cards-3、list、timeline、comparison、quote、chart
**9 种配色主题：** neon-green（推荐）、neon-blue、neon-purple、neon-orange、glass-light、glass-dark、minimal-mono、corporate、apple-dark`,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: '演示文稿的主题/标题',
      },
      content: {
        type: 'string',
        description: '详细内容大纲（Markdown 格式）',
      },
      slides_count: {
        type: 'number',
        description: '幻灯片数量（默认: 10）',
        default: 10,
      },
      theme: {
        type: 'string',
        enum: [
          'neon-green', 'neon-blue', 'neon-purple', 'neon-orange',
          'glass-light', 'glass-dark', 'minimal-mono', 'corporate',
          'apple-dark',
        ],
        description: '配色主题（默认: neon-green）',
        default: 'neon-green',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径',
      },
      images: {
        type: 'array',
        description: '要嵌入的图片列表',
        items: {
          type: 'object',
          properties: {
            slide_index: { type: 'number', description: '幻灯片索引（从 0 开始）' },
            image_path: { type: 'string', description: '图片文件路径' },
            position: { type: 'string', enum: ['right', 'left', 'center', 'background', 'bento'] },
          },
          required: ['slide_index', 'image_path'],
        },
      },
      use_masters: {
        type: 'boolean',
        description: '使用 Slide Master 模式（默认: true）',
        default: true,
      },
      chart_mode: {
        type: 'string',
        enum: ['auto', 'none'],
        description: '图表模式：auto 自动检测数据生成原生图表，none 不生成图表（默认: auto）',
        default: 'auto',
      },
      normalize_density: {
        type: 'boolean',
        description: '启用信息密度控制（默认: false）',
        default: false,
      },
      mode: {
        type: 'string',
        enum: ['generate', 'template', 'design'],
        description: '生成模式: generate（结构化模板）、template（PPTX 模板）、design（LLM 直接编写代码，视觉最优）',
        default: 'generate',
      },
      template_path: {
        type: 'string',
        description: '模板文件路径（mode=template 时必填）',
      },
      placeholders: {
        type: 'object',
        description: '占位符替换映射（mode=template 时使用）',
      },
      data_source: {
        type: 'string',
        description: '数据源文件路径（.xlsx 或 .csv）',
      },
      slides: {
        type: 'array',
        description: `结构化幻灯片定义（推荐，优于 content 参数）。每张 slide 指定 layout + 对应字段。

每种 layout 需要的字段（直接放在 slide 对象上）：
- "stats": stats 数组 [{label, value, description?}]
- "cards-3": cards 数组 [{title, description}]（恰好3项）
- "list": points 数组 [string]
- "timeline": steps 数组 [{title, description}]
- "comparison": left/right {title, points:[]}
- "quote": quote + attribution 字符串
- "chart": points 数组 + chartData {labels, values, chartType}

每页可附带 speakerNotes（演讲者口述稿，100-200 字）`,
        items: {
          type: 'object',
          properties: {
            layout: { type: 'string', enum: ['stats', 'cards-2', 'cards-3', 'list', 'timeline', 'comparison', 'quote', 'chart'] },
            title: { type: 'string' },
            subtitle: { type: 'string' },
            isTitle: { type: 'boolean' },
            isEnd: { type: 'boolean' },
            speakerNotes: { type: 'string', description: '演讲者口述稿（100-200字）' },
            stats: { type: 'array' },
            cards: { type: 'array' },
            points: { type: 'array' },
            steps: { type: 'array' },
            left: { type: 'object' },
            right: { type: 'object' },
            quote: { type: 'string' },
            attribution: { type: 'string' },
            mainCard: { type: 'object' },
            chartData: { type: 'object' },
          },
          required: ['layout', 'title'],
        },
      },
      preview: {
        type: 'boolean',
        description: '仅预览不生成文件（默认: false）',
        default: false,
      },
      research: {
        type: 'boolean',
        description: '启用深度搜索（默认: true）。设为 false 可跳过搜索，加快生成',
        default: true,
      },
      review: {
        type: 'boolean',
        description: '启用 VLM 视觉审查（默认: true）。需要安装 LibreOffice',
        default: true,
      },
      auto_illustrate: {
        type: 'boolean',
        description: '是否自动为幻灯片生成 AI 配图（CogView/FLUX），默认 false',
        default: false,
      },
    },
    required: ['topic'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
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
    } = params as unknown as PPTGenerateParams & { research?: boolean; review?: boolean; auto_illustrate?: boolean };

    const isPreview = preview === true;
    const shouldNormalizeDensity = normalize_density === true;
    const shouldResearch = enableResearch !== false;
    const shouldReview = enableReview !== false;

    try {
      const timestamp = Date.now();
      const fileName = `presentation-${timestamp}.pptx`;
      const outputDir = output_path ? path.dirname(output_path) : context.workingDirectory;
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
          return { success: false, error: result.error || '模板处理失败' };
        }

        const stats = fs.statSync(finalPath);
        return {
          success: true,
          output: `PPT 已生成（模板模式）

文件: ${finalPath}
模板: ${template_path}
幻灯片: ${result.slidesProcessed} 页
替换占位符: ${result.placeholdersReplaced} 个
大小: ${formatFileSize(stats.size)}

点击文件路径可直接打开。`,
          metadata: {
            filePath: finalPath,
            fileName: path.basename(finalPath),
            fileSize: stats.size,
            slidesCount: result.slidesProcessed,
            mode: 'template',
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
      logger.debug(`Topic brief: ${brief.audience}/${brief.style}, ${brief.keywords.join(',')}`);

      // ② 深度搜索（如果启用且有 modelCallback）
      let researchContext: ResearchContext | undefined;
      if (shouldResearch && context.modelCallback && !rawSlides && !content && !data_source) {
        logger.debug('Executing deep research...');
        try {
          // 注意：webSearch/webFetch 由调用方（Agent LLM）通过 tool_use 执行
          // 这里只用 modelCallback 做 LLM 结构化提取
          // 实际 web_search 需要在 Skill 层由 Agent 调用
          researchContext = await executeResearch(brief, context.modelCallback);
          logger.debug(`Research: ${researchContext.facts.length} facts, ${researchContext.statistics.length} stats`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Research failed, continuing without: ${message}`);
        }
      }

      // ===== VLM Callback（视觉模型审查） =====
      const zhipuApiKey = process.env.ZHIPU_API_KEY;
      const vlmCallback: VlmCallback | undefined = zhipuApiKey ? async (prompt: string, imagePath: string): Promise<string> => {
        const imageData = fs.readFileSync(imagePath);
        const base64 = imageData.toString('base64');
        const ext = path.extname(imagePath).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

        logger.debug(`VLM request: file=${path.basename(imagePath)}, mime=${mime}, b64len=${base64.length}`);

        const reqBody = JSON.stringify({
          model: ZHIPU_VISION_MODEL,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ]}],
          max_tokens: MODEL_MAX_TOKENS.VISION,
        });

        // 使用 https 模块代替 fetch（避免 CLI 环境中 fetch 的连接复用问题）
        const apiUrl = new URL(`${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`);
        return new Promise<string>((resolve, reject) => {
          const req = https.request({
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
          }, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
              if (res.statusCode !== 200) {
                logger.warn(`GLM-4V HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
                reject(new Error(`GLM-4V error: ${res.statusCode} ${data.slice(0, 100)}`));
                return;
              }
              try {
                const json = JSON.parse(data) as { choices?: Array<{ message?: { content?: string } }> };
                resolve(json.choices?.[0]?.message?.content || '');
              } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                reject(new Error(`VLM JSON parse error: ${message}`));
              }
            });
          });
          req.on('error', (e: Error) => reject(e));
          req.on('timeout', () => { req.destroy(); reject(new Error(`VLM request timeout (${VLM_REQUEST_TIMEOUT / 1000}s)`)); });
          req.write(reqBody);
          req.end();
        });
      } : undefined;

      if (vlmCallback) {
        logger.debug('VLM callback enabled (GLM-4V via ZHIPU_API_KEY)');
      }

      // ===== Design Mode =====
      if (mode === 'design' && context.modelCallback) {
        const { executeDesignMode } = await import('./designMode');
        const pptxgenPath = require.resolve('pptxgenjs/package.json');
        const designResult = await executeDesignMode({
          topic,
          slideCount: slides_count as number,
          theme: themeConfig,
          outputPath: finalPath,
          projectRoot: path.dirname(pptxgenPath),
          modelCallback: context.modelCallback,
          vlmCallback,
          researchContext,
          enableReview: shouldReview,
        });

        if (designResult.success) {
          const stats = fs.statSync(finalPath);
          const researchInfo = researchContext
            ? `，深度搜索（${researchContext.facts.length} 事实，${researchContext.statistics.length} 数据）`
            : '';
          return {
            success: true,
            output: `PPT 已生成（Design Mode，${designResult.iterations} 轮迭代${researchInfo}）\n\n文件: ${finalPath}\n主题: ${themeConfig.name} (${theme})\n幻灯片: ${designResult.slidesCount || slides_count} 页\n大小: ${formatFileSize(stats.size)}\n\n点击文件路径可直接打开。`,
            metadata: {
              filePath: finalPath,
              fileName: path.basename(finalPath),
              fileSize: stats.size,
              slidesCount: designResult.slidesCount || slides_count,
              theme,
              mode: 'design',
              iterations: designResult.iterations,
              hasResearch: !!researchContext,
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
        logger.warn('Design mode failed, falling back to generate mode');
        // 不 return，继续走下方 v7 generate 流程
      }

      // ===== 生成模式 =====
      const Pptx = getPptxGenJS();
      const pptx = new Pptx();

      pptx.author = 'Code Agent';
      pptx.title = topic;
      pptx.subject = topic;
      pptx.company = 'Generated by Code Agent';

      const slideImages = [...((images as SlideImage[]) || [])];

      // ===== 多通道内容生成 =====
      let structuredSlides: StructuredSlide[] | null = null;
      let legacySlides: import('./types').SlideData[] | null = null;

      if (rawSlides && Array.isArray(rawSlides) && rawSlides.length > 0) {
        // 通道 A：结构化 JSON 输入
        const { validSlides, errors } = validateStructuredSlides(rawSlides as StructuredSlide[]);
        if (validSlides.length > 0) {
          structuredSlides = validSlides;
          if (errors.length > 0) {
            logger.debug(`Structured slides: ${validSlides.length} valid, ${errors.length} rejected`);
          }
        } else {
          logger.warn(`All structured slides failed validation, falling back to legacy`);
          legacySlides = content
            ? parseContentToSlides(content, slides_count)
            : outlineToSlideData(topic, slides_count);
        }
      } else if (data_source) {
        // D2: 数据源驱动
        const dataResult = await loadDataSource(data_source);
        legacySlides = analyzeDataForPresentation(dataResult, topic);
      } else if (!content && context.modelCallback) {
        // ⑤ 通道 C：模型生成结构化 slides（v7 注入 ResearchContext）
        const generated = await generateStructuredSlides(
          topic,
          slides_count,
          context.modelCallback,
          researchContext, // v7: 注入研究数据
        );
        if (generated && generated.length > 0) {
          structuredSlides = generated;
          logger.debug(`Model generated ${generated.length} structured slides`);
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
          logger.debug(`Injected ${chartDataList.length} charts from research data`);
        }
      }

      // ⑥.5 AI 配图自动生成（可选，仅结构化通道）
      if (autoIllustrate && structuredSlides) {
        logger.debug('Generating AI illustrations for slides...');
        try {
          const illustrationImages = await generateSlideIllustrations(
            structuredSlides,
            themeConfig.name,
            { maxImages: 3, engine: 'auto' },
            outputDir,
          );
          if (illustrationImages.length > 0) {
            slideImages.push(...illustrationImages);
            logger.debug(`Added ${illustrationImages.length} AI-generated illustrations`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`AI illustration generation failed, continuing without: ${message}`);
        }
      }

      // D3: 信息密度控制（仅传统通道）
      if (legacySlides && shouldNormalizeDensity) {
        legacySlides = normalizeDensity(legacySlides);
      }

      if (legacySlides) {
        validateNarrative(legacySlides);
      }

      const totalSlides = structuredSlides?.length ?? legacySlides?.length ?? 0;

      // D5: 预览模式
      if (isPreview) {
        if (legacySlides) {
          const previewText = generateSlidePreview(legacySlides);
          return {
            success: true,
            output: previewText,
            metadata: { slidesCount: totalSlides, mode: 'preview' },
          };
        }
        const lines = (structuredSlides || []).map((s, i) => {
          const notes = s.speakerNotes ? ' 📝' : '';
          return `[${i + 1}] ${s.title} (${s.layout})${notes}`;
        });
        return {
          success: true,
          output: `预览（${totalSlides} 页）\n\n${lines.join('\n')}`,
          metadata: { slidesCount: totalSlides, mode: 'preview' },
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
          // Use CONTENT_IMAGE master when slide has images (including AI illustrations)
          if (currentSlideImages.length > 0 && !slideData.isTitle && !slideData.isEnd) {
            master = MASTER.CONTENT_IMAGE;
          }
          const slide = pptx.addSlide({ masterName: master });
          fillStructuredSlide(pptx, slide, slideData, themeConfig, i, null, currentSlideImages);

          // v7: 写入 Speaker Notes
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
            chart_mode as ChartMode
          );

          const slide = pptx.addSlide({ masterName: master });
          fillSlide(pptx, slide, slideData, themeConfig, layout, i, chartData, currentSlideImages);
        }
      }

      await pptx.writeFile({ fileName: finalPath });
      let stats = fs.statSync(finalPath);

      // ⑧⑨⑩ VLM 视觉审查循环（最多 2 轮）
      let reviewSummary = '';
      if (shouldReview && context.modelCallback && isLibreOfficeAvailable()) {
        logger.debug('Starting visual review...');
        try {
          const results = await reviewPresentation(finalPath, context.modelCallback, vlmCallback);
          if (results.length > 0) {
            const summary = summarizeReview(results);
            reviewSummary = `\n视觉审查: 平均 ${summary.averageScore}/5.0，${summary.totalIssues} 个问题`;
            if (summary.highSeverityCount > 0) {
              reviewSummary += `（${summary.highSeverityCount} 个严重）`;
            }
            logger.debug(`Review: avg=${summary.averageScore}, issues=${summary.totalIssues}`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Visual review failed: ${message}`);
        }
      }

      stats = fs.statSync(finalPath);
      const chartInfo = chart_mode === 'auto' ? '，原生图表自动检测' : '';
      const dataInfo = data_source ? `，数据源: ${path.basename(data_source)}` : '';
      const modeInfo = structuredSlides ? '，结构化 JSON' : '';
      const researchInfo = researchContext ? `，深度搜索（${researchContext.facts.length} 事实，${researchContext.statistics.length} 数据）` : '';
      const notesCount = structuredSlides?.filter(s => s.speakerNotes).length || 0;
      const notesInfo = notesCount > 0 ? `，${notesCount} 页演讲稿` : '';
      const illustrationCount = autoIllustrate ? slideImages.filter(img => img.image_path.includes('illustration-')).length : 0;
      const illustrationInfo = illustrationCount > 0 ? `，${illustrationCount} 张 AI 配图` : '';

      return {
        success: true,
        output: `PPT 已生成（v7 工作流${chartInfo}${dataInfo}${modeInfo}${researchInfo}${notesInfo}${illustrationInfo}）

文件: ${finalPath}
主题: ${themeConfig.name} (${theme})
幻灯片: ${totalSlides} 页
大小: ${formatFileSize(stats.size)}${reviewSummary}

点击文件路径可直接打开。`,
        metadata: {
          filePath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: stats.size,
          slidesCount: totalSlides,
          theme,
          chartMode: chart_mode,
          hasResearch: !!researchContext,
          hasSpeakerNotes: notesCount > 0,
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
      return {
        success: false,
        error: `PPT 生成失败: ${message}`,
      };
    }
  },
};
