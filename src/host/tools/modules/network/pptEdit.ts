// ============================================================================
// ppt_edit (P1 Wave 4 D2a — network/ppt: native ToolModule rewrite)
//
// 在已有 PPTX 文件上做轻量编辑：替换标题/正文、删/重排页、提样式、分析、改备注。
// 所有写操作前自动 createSnapshot，失败 restoreLatest 回滚。
//
// 行为保真：legacy 输出格式（中文文案 + emoji + snapshot id）必须 1:1 复刻。
// 内部 helpers (styleExtractor) 保留在 src/host/tools/media/ppt/。
// ============================================================================

import * as fs from 'fs';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { createSnapshot, restoreLatest } from '../../document/snapshotManager';
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { pptEditSchema as schema } from './pptEdit.schema';

type EditAction =
  | 'replace_title'
  | 'replace_content'
  | 'replace_slide'
  | 'delete_slide'
  | 'insert_slide'
  | 'extract_style'
  | 'reorder_slides'
  | 'update_notes'
  | 'analyze';

interface PPTEditParams {
  file_path: string;
  action: EditAction;
  slide_index?: number;
  content?: string;
  title?: string;
  points?: string[];
  order?: number[];
  notes?: string;
}

const VALID_ACTIONS: EditAction[] = [
  'replace_title',
  'replace_content',
  'replace_slide',
  'delete_slide',
  'insert_slide',
  'extract_style',
  'reorder_slides',
  'update_notes',
  'analyze',
];

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 替换 slide XML 中第一个 <a:t> 的文本（一般是标题） */
function replaceFirstTextRun(xml: string, newText: string, isTitle: boolean): string {
  const escaped = escapeXml(newText);
  if (isTitle) {
    let replaced = false;
    return xml.replace(/<a:t>([^<]*)<\/a:t>/g, (match) => {
      if (!replaced) {
        replaced = true;
        return `<a:t>${escaped}</a:t>`;
      }
      return match;
    });
  }
  return xml;
}

/** 替换正文区文本（跳过第一个 a:t，按行分割写回 a:t） */
function replaceBodyContent(xml: string, newContent: string): string {
  const escaped = escapeXml(newContent);
  const lines = escaped.split('\n');

  let count = 0;
  let lineIndex = 0;
  return xml.replace(/<a:t>([^<]*)<\/a:t>/g, (match) => {
    count++;
    if (count <= 1) return match;
    if (lineIndex < lines.length) {
      return `<a:t>${lines[lineIndex++]}</a:t>`;
    }
    return `<a:t></a:t>`;
  });
}

export async function executePptEdit(
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

  const params = args as unknown as PPTEditParams;
  const { file_path, action, slide_index, content, title, points, order, notes } = params;

  if (typeof file_path !== 'string' || file_path.length === 0) {
    return { ok: false, error: 'file_path is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as EditAction)) {
    return {
      ok: false,
      error: `action must be one of: ${VALID_ACTIONS.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }

  if (!fs.existsSync(file_path)) {
    return { ok: false, error: `文件不存在: ${file_path}` };
  }

  try {
    // jszip 是 CJS，运行时构造；类型 unknown 以避免拉 .d.ts
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const JSZip = require('jszip') as { loadAsync(data: Buffer): Promise<JsZipInstance> };

    const snapshot = createSnapshot(file_path, `ppt-edit: ${action}`);
    const data = fs.readFileSync(file_path);
    const zip = await JSZip.loadAsync(data);

    let resultMessage = '';

    switch (action) {
      case 'replace_title': {
        if (slide_index === undefined) {
          return { ok: false, error: 'replace_title 需要 slide_index 参数', code: 'INVALID_ARGS' };
        }
        const slideFile = `ppt/slides/slide${slide_index + 1}.xml`;
        if (!zip.files[slideFile]) {
          return { ok: false, error: `幻灯片 ${slide_index} 不存在` };
        }
        let xml = await zip.files[slideFile].async('string');
        const newTitle = title || content || '';
        xml = replaceFirstTextRun(xml, newTitle, true);
        zip.file(slideFile, xml);
        resultMessage = `已替换第 ${slide_index + 1} 页标题为: "${newTitle}"`;
        break;
      }

      case 'replace_content': {
        if (slide_index === undefined) {
          return { ok: false, error: 'replace_content 需要 slide_index 参数', code: 'INVALID_ARGS' };
        }
        const slideFile = `ppt/slides/slide${slide_index + 1}.xml`;
        if (!zip.files[slideFile]) {
          return { ok: false, error: `幻灯片 ${slide_index} 不存在` };
        }
        let xml = await zip.files[slideFile].async('string');
        const newContent = points ? points.join('\n') : (content || '');
        xml = replaceBodyContent(xml, newContent);
        zip.file(slideFile, xml);
        resultMessage = `已替换第 ${slide_index + 1} 页内容`;
        break;
      }

      case 'replace_slide': {
        if (slide_index === undefined) {
          return { ok: false, error: 'replace_slide 需要 slide_index 参数', code: 'INVALID_ARGS' };
        }
        const slideFile = `ppt/slides/slide${slide_index + 1}.xml`;
        if (!zip.files[slideFile]) {
          return { ok: false, error: `幻灯片 ${slide_index} 不存在` };
        }
        let xml = await zip.files[slideFile].async('string');
        if (title) xml = replaceFirstTextRun(xml, title, true);
        if (points || content) {
          const newContent = points ? points.join('\n') : (content || '');
          xml = replaceBodyContent(xml, newContent);
        }
        zip.file(slideFile, xml);
        resultMessage = `已替换第 ${slide_index + 1} 页`;
        break;
      }

      case 'delete_slide': {
        if (slide_index === undefined) {
          return { ok: false, error: 'delete_slide 需要 slide_index 参数', code: 'INVALID_ARGS' };
        }
        const slideFile = `ppt/slides/slide${slide_index + 1}.xml`;
        const relFile = `ppt/slides/_rels/slide${slide_index + 1}.xml.rels`;
        if (!zip.files[slideFile]) {
          return { ok: false, error: `幻灯片 ${slide_index} 不存在` };
        }
        zip.remove(slideFile);
        if (zip.files[relFile]) zip.remove(relFile);

        if (zip.files['ppt/presentation.xml']) {
          let presXml = await zip.files['ppt/presentation.xml'].async('string');
          const slideRel = new RegExp(`<p:sldId[^>]*r:id="rId${slide_index + 2}"[^/]*/?>`, 'g');
          presXml = presXml.replace(slideRel, '');
          zip.file('ppt/presentation.xml', presXml);
        }
        resultMessage = `已删除第 ${slide_index + 1} 页`;
        break;
      }

      case 'insert_slide': {
        // legacy 行为：只返回提示，不真正插入
        resultMessage =
          '插入新幻灯片建议使用 frontend-slides（或 /ppt）重新生成。当前支持在已有幻灯片上 replace_title / replace_content。';
        break;
      }

      case 'extract_style': {
        const { extractStyleFromPptx } = await import('../../media/ppt/styleExtractor');
        const styleConfig = await extractStyleFromPptx(file_path);
        if (!styleConfig) {
          return { ok: false, error: '无法提取样式，可能不是有效的 PPTX 文件' };
        }
        onProgress?.({ stage: 'completing', percent: 100 });
        return {
          ok: true,
          output: `已提取主题样式:

背景色: #${styleConfig.bgColor}
文字色: #${styleConfig.textPrimary}
强调色: #${styleConfig.accent}
标题字体: ${styleConfig.fontTitle}
正文字体: ${styleConfig.fontBody}
深色主题: ${styleConfig.isDark ? '是' : '否'}`,
          meta: {
            artifact: createVirtualArtifact({
              sourceTool: schema.name,
              kind: 'text',
              sessionId: ctx.sessionId,
              name: `PPT style: ${file_path}`,
              mimeType: 'application/json',
              contentLength: JSON.stringify(styleConfig).length,
              preview: JSON.stringify(styleConfig).slice(0, 500),
              metadata: { action, filePath: file_path },
            }),
            styleConfig,
            action,
            filePath: file_path,
            contentLength: JSON.stringify(styleConfig).length,
            truncated: false,
          },
        };
      }

      case 'reorder_slides': {
        if (!order || order.length === 0) {
          return {
            ok: false,
            error: 'reorder_slides 需要 order 参数（如 [2,0,1,3]）',
            code: 'INVALID_ARGS',
          };
        }

        const slideFiles = Object.keys(zip.files).filter((f) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(f),
        );
        if (order.length !== slideFiles.length) {
          return {
            ok: false,
            error: `order 长度 (${order.length}) 必须等于幻灯片数 (${slideFiles.length})`,
            code: 'INVALID_ARGS',
          };
        }

        const slideContents: Map<number, string> = new Map();
        const slideRels: Map<number, string | null> = new Map();
        for (let i = 0; i < slideFiles.length; i++) {
          const slideFile = `ppt/slides/slide${i + 1}.xml`;
          const relFile = `ppt/slides/_rels/slide${i + 1}.xml.rels`;
          slideContents.set(i, await zip.files[slideFile].async('string'));
          slideRels.set(i, zip.files[relFile] ? await zip.files[relFile].async('string') : null);
        }

        for (let newIdx = 0; newIdx < order.length; newIdx++) {
          const oldIdx = order[newIdx];
          const slideFile = `ppt/slides/slide${newIdx + 1}.xml`;
          const relFile = `ppt/slides/_rels/slide${newIdx + 1}.xml.rels`;
          const slideContent = slideContents.get(oldIdx);
          if (slideContent === undefined) {
            return {
              ok: false,
              error: `order 索引越界: ${oldIdx} 不在 [0, ${slideFiles.length})`,
              code: 'INVALID_ARGS',
            };
          }
          zip.file(slideFile, slideContent);
          const rel = slideRels.get(oldIdx);
          if (rel) zip.file(relFile, rel);
        }

        resultMessage = `已调整幻灯片顺序: [${order.join(',')}]`;
        break;
      }

      case 'analyze': {
        const slideFiles = Object.keys(zip.files)
          .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
          .sort();
        const slideCount = slideFiles.length;
        const slides: Array<{
          index: number;
          title: string;
          textRuns: number;
          imageCount: number;
          tableCount: number;
        }> = [];

        for (let i = 0; i < slideCount; i++) {
          const slideFile = `ppt/slides/slide${i + 1}.xml`;
          if (!zip.files[slideFile]) continue;
          const slideXml: string = await zip.files[slideFile].async('string');

          const titleMatch = slideXml.match(/<a:t>([^<]*)<\/a:t>/);
          const slideTitle = titleMatch ? titleMatch[1] : '(无标题)';

          const textRuns = (slideXml.match(/<a:t>/g) || []).length;
          const imageCount = (slideXml.match(/<a:blip/g) || []).length;
          const tableCount = (slideXml.match(/<a:tbl>/g) || []).length;

          slides.push({ index: i, title: slideTitle, textRuns, imageCount, tableCount });
        }

        let themeColors = '';
        const themeFile = Object.keys(zip.files).find((f) =>
          /^ppt\/theme\/theme\d+\.xml$/.test(f),
        );
        if (themeFile && zip.files[themeFile]) {
          const themeXml: string = await zip.files[themeFile].async('string');
          const colorMatches = themeXml.match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/g) || [];
          const colors = colorMatches.slice(0, 8).map((m) => '#' + m.match(/val="([^"]+)"/)?.[1]);
          themeColors = colors.join(', ');
        }

        const fonts = new Set<string>();
        for (const sf of slideFiles) {
          const sXml: string = await zip.files[sf].async('string');
          const fontMatches = sXml.match(/typeface="([^"]+)"/g) || [];
          fontMatches.forEach((m) => {
            const f = m.match(/typeface="([^"]+)"/)?.[1];
            if (f && !f.startsWith('+')) fonts.add(f);
          });
        }

        const masterFiles = Object.keys(zip.files).filter(
          (f) => /^ppt\/slideMasters\//.test(f) && f.endsWith('.xml'),
        );
        const layoutFiles = Object.keys(zip.files).filter(
          (f) => /^ppt\/slideLayouts\//.test(f) && f.endsWith('.xml'),
        );

        let output = `📊 PPTX 分析结果\n\n`;
        output += `📄 幻灯片: ${slideCount} 页\n`;
        output += `🎨 母版: ${masterFiles.length} 个\n`;
        output += `📐 布局: ${layoutFiles.length} 个\n`;
        if (themeColors) output += `🎨 主题色: ${themeColors}\n`;
        output += `🔤 字体: ${[...fonts].join(', ') || '(无自定义字体)'}\n\n`;
        output += `📑 内容概要:\n`;
        for (const s of slides) {
          output += `  ${s.index + 1}. "${s.title}" — ${s.textRuns} 文本`;
          if (s.imageCount) output += `, ${s.imageCount} 图片`;
          if (s.tableCount) output += `, ${s.tableCount} 表格`;
          output += '\n';
        }

        onProgress?.({ stage: 'completing', percent: 100 });
        return {
          ok: true,
          output,
          meta: {
            artifact: createVirtualArtifact({
              sourceTool: schema.name,
              kind: 'text',
              sessionId: ctx.sessionId,
              name: `PPT analysis: ${file_path}`,
              mimeType: 'text/markdown',
              contentLength: output.length,
              preview: output.slice(0, 500),
              metadata: {
                action,
                filePath: file_path,
                slideCount,
                masterCount: masterFiles.length,
                layoutCount: layoutFiles.length,
              },
            }),
            slideCount,
            slides,
            fonts: [...fonts],
            themeColors,
            masterCount: masterFiles.length,
            layoutCount: layoutFiles.length,
            action,
            filePath: file_path,
            resultCount: slideCount,
            contentLength: output.length,
            truncated: false,
          },
        };
      }

      case 'update_notes': {
        if (slide_index === undefined) {
          return { ok: false, error: 'update_notes 需要 slide_index 参数', code: 'INVALID_ARGS' };
        }
        const notesFile = `ppt/notesSlides/notesSlide${slide_index + 1}.xml`;
        const noteText = notes || content || '';
        const escapedNote = escapeXml(noteText);

        if (zip.files[notesFile]) {
          let notesXml = await zip.files[notesFile].async('string');
          let noteReplaced = false;
          notesXml = notesXml.replace(/<a:t>([^<]*)<\/a:t>/g, (match: string) => {
            if (!noteReplaced) {
              noteReplaced = true;
              return match;
            }
            return `<a:t>${escapedNote}</a:t>`;
          });
          zip.file(notesFile, notesXml);
        }
        resultMessage = `已更新第 ${slide_index + 1} 页演讲者备注`;
        break;
      }
    }

    const noWriteActions = new Set(['extract_style', 'analyze']);
    if (!noWriteActions.has(action)) {
      const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      fs.writeFileSync(file_path, outputBuffer);
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: `${resultMessage}\nSnapshot: ${snapshot.id}`,
      meta: {
        artifact: await createFileArtifact(file_path, schema.name, ctx, {
          kind: 'document',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          metadata: {
            action,
            slideIndex: slide_index,
            snapshotId: snapshot.id,
          },
        }),
        snapshotId: snapshot.id,
        action,
        slideIndex: slide_index,
        filePath: file_path,
        outputPath: file_path,
        contentLength: fs.statSync(file_path).size,
        truncated: false,
      },
    };
  } catch (error: unknown) {
    restoreLatest(file_path);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `PPT 编辑失败 (已从快照恢复): ${message}` };
  }
}

class PptEditHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePptEdit(args, ctx, canUseTool, onProgress);
  }
}

export const pptEditModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PptEditHandler();
  },
};

// ── 内部 jszip 类型简表，避免拉 @types/jszip ──
interface JsZipFile {
  async(type: 'string'): Promise<string>;
}
interface JsZipInstance {
  files: Record<string, JsZipFile>;
  file(name: string, data: string | Buffer): void;
  remove(name: string): void;
  generateAsync(opts: { type: 'nodebuffer' }): Promise<Buffer>;
  loadAsync?(data: Buffer): Promise<JsZipInstance>;
}
