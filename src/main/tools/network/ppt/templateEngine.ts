// ============================================================================
// PPT 模板引擎 - 基于 JSZip 的模板驱动生成 + 多模板融合
// ============================================================================
// v7 增强：
// - 修复 importAutomizer bug（直接用 JSZip 操作 ZIP）
// - 新增 parseTemplateProfile（提取模板布局/配色/字体）
// - 新增 mergeTemplateProfiles（多模板取长补短）
// - 新增 assembleFromTemplate（用结构化 slides 填充模板）
// - 新增 speaker notes 注入
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../../services/infra/logger';
import { DEFAULT_FALLBACK_COLORS, DEFAULT_FALLBACK_FONTS, EMU_PER_INCH } from './constants';
import type { TemplateProfile, MergedTemplateProfile, TemplateMetadata } from './types';
import type { StructuredSlide } from './slideSchemas';

const logger = createLogger('TemplateEngine');

// ============================================================================
// Template Result
// ============================================================================

export interface TemplateResult {
  success: boolean;
  outputPath?: string;
  slidesProcessed?: number;
  placeholdersReplaced?: number;
  error?: string;
}

// ============================================================================
// JSZip Loader
// ============================================================================

function getJSZip(): any {
  try {
    return require('jszip');
  } catch {
    throw new Error('jszip is not installed. Run: npm install jszip');
  }
}

// ============================================================================
// Template Placeholder Replacement (Original D1 功能 — 修复版)
// ============================================================================

/**
 * Generate a PPTX from a template by replacing {{placeholders}}
 */
export async function generateFromTemplate(
  templatePath: string,
  placeholders: Record<string, string>,
  outputPath: string,
): Promise<TemplateResult> {
  if (!fs.existsSync(templatePath)) {
    return { success: false, error: `Template not found: ${templatePath}` };
  }

  try {
    const JSZip = getJSZip();
    const data = fs.readFileSync(templatePath);
    const zip = await JSZip.loadAsync(data);

    let slidesProcessed = 0;
    let placeholdersReplaced = 0;

    const slideFiles = Object.keys(zip.files).filter(f =>
      f.startsWith('ppt/slides/slide') && f.endsWith('.xml')
    );

    for (const slideFile of slideFiles) {
      slidesProcessed++;
      let xmlContent = await zip.files[slideFile].async('string');
      let modified = false;

      for (const [tag, value] of Object.entries(placeholders)) {
        const pattern = `{{${tag}}}`;
        if (xmlContent.includes(pattern)) {
          const escapedValue = escapeXml(value);
          xmlContent = xmlContent.split(pattern).join(escapedValue);
          placeholdersReplaced++;
          modified = true;
        }
      }

      if (modified) {
        zip.file(slideFile, xmlContent);
      }
    }

    const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(outputPath, outputBuffer);

    return { success: true, outputPath, slidesProcessed, placeholdersReplaced };
  } catch (error: any) {
    return { success: false, error: `Template processing failed: ${error.message}` };
  }
}

// ============================================================================
// Template Profile Extraction (v7 新增)
// ============================================================================

/**
 * 解析 PPTX 模板，提取布局、配色、字体等信息
 */
export async function parseTemplateProfile(pptxPath: string): Promise<TemplateProfile | null> {
  if (!fs.existsSync(pptxPath)) return null;

  try {
    const JSZip = getJSZip();
    const data = fs.readFileSync(pptxPath);
    const zip = await JSZip.loadAsync(data);

    // 提取 theme
    const colorScheme = await extractColorSchemeFromZip(zip);
    const fonts = await extractFontsFromZip(zip);

    // 提取 slide layouts
    const layouts = await extractLayoutsFromZip(zip);

    return {
      id: path.basename(pptxPath, '.pptx'),
      filePath: pptxPath,
      layouts,
      colorScheme,
      fonts,
    };
  } catch (err: any) {
    logger.warn(`Failed to parse template profile: ${err.message}`);
    return null;
  }
}

/**
 * 从 ZIP 提取配色方案
 */
async function extractColorSchemeFromZip(zip: any): Promise<TemplateProfile['colorScheme']> {
  const defaults = { ...DEFAULT_FALLBACK_COLORS };

  try {
    const themeFile = Object.keys(zip.files).find((f: string) =>
      f.startsWith('ppt/theme/theme') && f.endsWith('.xml')
    );
    if (!themeFile) return defaults;

    const xml = await zip.files[themeFile].async('string');

    // 提取颜色
    const dk1Match = xml.match(/<a:dk1>.*?(?:val|lastClr)="([0-9A-Fa-f]{6})"/s);
    const lt1Match = xml.match(/<a:lt1>.*?(?:val|lastClr)="([0-9A-Fa-f]{6})"/s);
    const accent1Match = xml.match(/<a:accent1>.*?srgbClr val="([0-9A-Fa-f]{6})"/s);
    const accent2Match = xml.match(/<a:accent2>.*?srgbClr val="([0-9A-Fa-f]{6})"/s);

    const bg = lt1Match ? lt1Match[1].toLowerCase() : defaults.background;
    const text = dk1Match ? dk1Match[1].toLowerCase() : defaults.text;

    return {
      background: bg,
      text: text,
      accent: accent1Match ? accent1Match[1].toLowerCase() : defaults.accent,
      secondary: accent2Match ? accent2Match[1].toLowerCase() : defaults.secondary,
    };
  } catch {
    return defaults;
  }
}

/**
 * 从 ZIP 提取字体方案
 */
async function extractFontsFromZip(zip: any): Promise<TemplateProfile['fonts']> {
  const defaults = { ...DEFAULT_FALLBACK_FONTS };

  try {
    const themeFile = Object.keys(zip.files).find((f: string) =>
      f.startsWith('ppt/theme/theme') && f.endsWith('.xml')
    );
    if (!themeFile) return defaults;

    const xml = await zip.files[themeFile].async('string');

    const majorMatch = xml.match(/<a:majorFont>[\s\S]*?<a:latin typeface="([^"]+)"/);
    const minorMatch = xml.match(/<a:minorFont>[\s\S]*?<a:latin typeface="([^"]+)"/);
    const majorEAMatch = xml.match(/<a:majorFont>[\s\S]*?<a:ea typeface="([^"]+)"/);
    const minorEAMatch = xml.match(/<a:minorFont>[\s\S]*?<a:ea typeface="([^"]+)"/);

    return {
      title: majorMatch ? majorMatch[1] : defaults.title,
      body: minorMatch ? minorMatch[1] : defaults.body,
      titleCN: majorEAMatch ? majorEAMatch[1] : undefined,
      bodyCN: minorEAMatch ? minorEAMatch[1] : undefined,
    };
  } catch {
    return defaults;
  }
}

/**
 * 从 ZIP 提取 slide layouts 信息
 */
async function extractLayoutsFromZip(zip: any): Promise<TemplateProfile['layouts']> {
  const layouts: TemplateProfile['layouts'] = [];

  try {
    const layoutFiles = Object.keys(zip.files)
      .filter((f: string) => f.startsWith('ppt/slideLayouts/slideLayout') && f.endsWith('.xml'))
      .sort();

    for (const layoutFile of layoutFiles) {
      const xml = await zip.files[layoutFile].async('string');

      // 提取 layout 名称
      const nameMatch = xml.match(/name="([^"]+)"/);
      const layoutName = nameMatch ? nameMatch[1] : path.basename(layoutFile, '.xml');

      // 提取 placeholders
      const placeholders: TemplateProfile['layouts'][number]['placeholders'] = [];
      const phRegex = /<p:sp>[\s\S]*?<p:ph([\s\S]*?)\/?>[\s\S]*?<a:off x="(\d+)" y="(\d+)"[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/g;
      let match;
      while ((match = phRegex.exec(xml)) !== null) {
        const attrs = match[1];
        const typeMatch = attrs.match(/type="([^"]+)"/);
        const phType = typeMatch ? typeMatch[1] : 'other';

        // EMU to inches
        const x = parseInt(match[2]) / EMU_PER_INCH;
        const y = parseInt(match[3]) / EMU_PER_INCH;
        const w = parseInt(match[4]) / EMU_PER_INCH;
        const h = parseInt(match[5]) / EMU_PER_INCH;

        placeholders.push({
          name: phType,
          type: mapPlaceholderType(phType),
          x, y, w, h,
        });
      }

      layouts.push({ name: layoutName, placeholders });
    }
  } catch (err: any) {
    logger.debug(`Layout extraction error: ${err.message}`);
  }

  return layouts;
}

function mapPlaceholderType(phType: string): 'title' | 'body' | 'image' | 'chart' | 'other' {
  if (/title|ctrTitle/.test(phType)) return 'title';
  if (/body|subTitle|dt|ftr|sldNum/.test(phType)) return 'body';
  if (/pic|img/.test(phType)) return 'image';
  if (/chart|dgm|tbl/.test(phType)) return 'chart';
  return 'other';
}

// ============================================================================
// Multi-Template Merge (v7 新增)
// ============================================================================

/**
 * 融合多个模板 Profile，取长补短
 *
 * 策略：
 * 1. 合并所有 layout（去重取并集）
 * 2. 每种 layout 保留 placeholder 最多的模板作为 bestSource
 * 3. 配色方案取主模板（第一个）
 * 4. 字体取主模板
 */
export function mergeTemplateProfiles(
  profiles: TemplateProfile[],
): MergedTemplateProfile {
  if (profiles.length === 0) {
    return {
      layouts: [],
      bestSource: {},
      colorScheme: { ...DEFAULT_FALLBACK_COLORS },
      fonts: { ...DEFAULT_FALLBACK_FONTS },
      templatePaths: [],
    };
  }

  if (profiles.length === 1) {
    const p = profiles[0];
    const bestSource: Record<string, string> = {};
    for (const l of p.layouts) {
      bestSource[l.name] = p.id;
    }
    return {
      layouts: p.layouts.map(l => l.name),
      bestSource,
      colorScheme: p.colorScheme,
      fonts: p.fonts,
      templatePaths: [p.filePath],
    };
  }

  // 合并 layouts 并选择最佳来源
  const allLayoutNames = new Set<string>();
  const bestSource: Record<string, string> = {};

  for (const profile of profiles) {
    for (const layout of profile.layouts) {
      const name = layout.name;
      allLayoutNames.add(name);

      // 比较 placeholder 数量，选最多的
      if (!bestSource[name]) {
        bestSource[name] = profile.id;
      } else {
        const currentBest = profiles.find(p => p.id === bestSource[name]);
        const currentLayout = currentBest?.layouts.find(l => l.name === name);
        if (layout.placeholders.length > (currentLayout?.placeholders.length || 0)) {
          bestSource[name] = profile.id;
        }
      }
    }
  }

  // 主模板 = 第一个（相关度最高）
  const primary = profiles[0];

  return {
    layouts: Array.from(allLayoutNames),
    bestSource,
    colorScheme: primary.colorScheme,
    fonts: primary.fonts,
    templatePaths: profiles.map(p => p.filePath),
  };
}

// ============================================================================
// Template-Based Assembly (v7 新增)
// ============================================================================

/**
 * 用结构化 Slides 填充模板 PPTX
 *
 * 替换模板中每页的文字占位符，注入 speaker notes
 */
export async function assembleFromTemplate(
  templatePath: string,
  slides: StructuredSlide[],
  outputPath: string,
): Promise<TemplateResult> {
  if (!fs.existsSync(templatePath)) {
    return { success: false, error: `Template not found: ${templatePath}` };
  }

  try {
    const JSZip = getJSZip();
    const data = fs.readFileSync(templatePath);
    const zip = await JSZip.loadAsync(data);

    const slideFiles = Object.keys(zip.files)
      .filter(f => f.startsWith('ppt/slides/slide') && f.endsWith('.xml'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
        const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
        return numA - numB;
      });

    let slidesProcessed = 0;
    let placeholdersReplaced = 0;

    // 逐页填充
    const maxSlides = Math.min(slides.length, slideFiles.length);
    for (let i = 0; i < maxSlides; i++) {
      const slide = slides[i];
      const slideFile = slideFiles[i];

      let xmlContent = await zip.files[slideFile].async('string');
      let modified = false;

      // 替换标题占位符
      const titleReplacements = [
        ['{{title}}', slide.title],
        ['{{subtitle}}', slide.subtitle || ''],
      ];

      for (const [tag, value] of titleReplacements) {
        if (xmlContent.includes(tag)) {
          xmlContent = xmlContent.split(tag).join(escapeXml(value));
          placeholdersReplaced++;
          modified = true;
        }
      }

      // 替换内容占位符
      const contentText = extractContentText(slide);
      if (xmlContent.includes('{{content}}') || xmlContent.includes('{{body}}')) {
        xmlContent = xmlContent
          .split('{{content}}').join(escapeXml(contentText))
          .split('{{body}}').join(escapeXml(contentText));
        placeholdersReplaced++;
        modified = true;
      }

      if (modified) {
        zip.file(slideFile, xmlContent);
      }

      // 注入 Speaker Notes
      if (slide.speakerNotes) {
        await injectSpeakerNotes(zip, slideFile, slide.speakerNotes);
      }

      slidesProcessed++;
    }

    const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(outputPath, outputBuffer);

    return { success: true, outputPath, slidesProcessed, placeholdersReplaced };
  } catch (error: any) {
    return { success: false, error: `Template assembly failed: ${error.message}` };
  }
}

/**
 * 注入 Speaker Notes 到指定 slide
 */
async function injectSpeakerNotes(
  zip: any,
  slideFile: string,
  notes: string,
): Promise<void> {
  try {
    // slide1.xml → notesSlide1.xml
    const slideNum = slideFile.match(/slide(\d+)/)?.[1];
    if (!slideNum) return;

    const notesFile = `ppt/notesSlides/notesSlide${slideNum}.xml`;

    // 如果 notes 文件已存在，替换内容
    if (zip.files[notesFile]) {
      let notesXml = await zip.files[notesFile].async('string');
      // 查找 body text 区域并替换
      const bodyMatch = notesXml.match(/<p:txBody>[\s\S]*?<\/p:txBody>/);
      if (bodyMatch) {
        const newBody = buildNotesBody(notes);
        notesXml = notesXml.replace(bodyMatch[0], newBody);
        zip.file(notesFile, notesXml);
      }
    } else {
      // 创建新的 notes slide
      const notesXml = buildNotesSlideXml(notes);
      zip.file(notesFile, notesXml);

      // 更新 slide rels 引用 notes
      const relsFile = slideFile.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
      if (zip.files[relsFile]) {
        let relsXml = await zip.files[relsFile].async('string');
        if (!relsXml.includes('notesSlide')) {
          relsXml = relsXml.replace(
            '</Relationships>',
            `<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${slideNum}.xml"/></Relationships>`
          );
          zip.file(relsFile, relsXml);
        }
      }
    }
  } catch (err: any) {
    logger.debug(`Failed to inject speaker notes: ${err.message}`);
  }
}

function buildNotesBody(text: string): string {
  const paragraphs = text.split('\n').filter(p => p.trim());
  const runs = paragraphs.map(p =>
    `<a:p><a:r><a:rPr lang="zh-CN" sz="1200"/><a:t>${escapeXml(p)}</a:t></a:r></a:p>`
  ).join('');
  return `<p:txBody><a:bodyPr/><a:lstStyle/>${runs}</p:txBody>`;
}

function buildNotesSlideXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        ${buildNotesBody(text)}
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`;
}

// ============================================================================
// Template Selection (v7 新增)
// ============================================================================

/**
 * 从模板索引中按 domain 筛选 Top 3
 */
export function selectTemplatesByDomain(
  templates: TemplateMetadata[],
  keywords: string[],
  style?: string,
): TemplateMetadata[] {
  // 计算每个模板的相关度分数
  const scored = templates
    .filter(t => t.status !== 'planned' || true) // 暂时包含 planned 状态
    .map(t => {
      let score = 0;
      for (const keyword of keywords) {
        for (const domain of t.domains) {
          if (domain.toLowerCase().includes(keyword.toLowerCase()) ||
              keyword.toLowerCase().includes(domain.toLowerCase())) {
            score += 2;
          }
        }
      }
      // 风格匹配加分
      if (style) {
        const styleDark = ['dark', 'tech', 'creative'].includes(style);
        if ((styleDark && t.style === 'dark') || (!styleDark && t.style === 'light')) {
          score += 1;
        }
      }
      return { template: t, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map(s => s.template);
}

/**
 * 加载模板索引
 */
export function loadTemplateIndex(indexPath: string): TemplateMetadata[] {
  try {
    if (!fs.existsSync(indexPath)) return [];
    const content = fs.readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.templates) ? parsed.templates : [];
  } catch {
    return [];
  }
}

// ============================================================================
// Helpers
// ============================================================================

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Extract placeholder tags from a template PPTX
 */
export async function extractPlaceholderTags(templatePath: string): Promise<string[]> {
  if (!fs.existsSync(templatePath)) return [];

  try {
    const JSZip = getJSZip();
    const data = fs.readFileSync(templatePath);
    const zip = await JSZip.loadAsync(data);

    const tags = new Set<string>();
    const tagPattern = /\{\{(\w+)\}\}/g;

    const slideFiles = Object.keys(zip.files).filter(f =>
      f.startsWith('ppt/slides/slide') && f.endsWith('.xml')
    );

    for (const slideFile of slideFiles) {
      const xml = await zip.files[slideFile].async('string');
      let match;
      while ((match = tagPattern.exec(xml)) !== null) {
        tags.add(match[1]);
      }
    }

    return Array.from(tags).sort();
  } catch {
    return [];
  }
}

/**
 * 从 StructuredSlide 提取纯文本内容
 */
function extractContentText(slide: StructuredSlide): string {
  const content = slide.content as any;
  if (!content) return '';

  if (content.points) {
    return content.points.join('\n');
  }
  if (content.stats) {
    return content.stats.map((s: any) => `${s.label}: ${s.value}`).join('\n');
  }
  if (content.steps) {
    return content.steps.map((s: any) => `${s.title}: ${s.description}`).join('\n');
  }
  if (content.cards) {
    return content.cards.map((c: any) => `${c.title}: ${c.description}`).join('\n');
  }
  if (content.quote) {
    return `${content.quote}\n— ${content.attribution || ''}`;
  }
  if (content.left && content.right) {
    return [
      ...(content.left.points || []),
      ...(content.right.points || []),
    ].join('\n');
  }

  return '';
}
