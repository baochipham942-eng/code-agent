// ============================================================================
// PPT Edit Tool - 编辑已有 PPTX 文件
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';

type EditAction = 'replace_title' | 'replace_content' | 'replace_slide' | 'delete_slide' | 'insert_slide' | 'extract_style';

interface PPTEditParams {
  file_path: string;
  action: EditAction;
  slide_index?: number;
  content?: string;
  title?: string;
  points?: string[];
}

export const pptEditTool: Tool = {
  name: 'ppt_edit',
  description: `编辑已有的 PPTX 文件。

**6 种操作：**
- replace_title: 替换指定页的标题
- replace_content: 替换指定页的正文内容
- replace_slide: 用新内容替换整张幻灯片
- delete_slide: 删除指定页
- insert_slide: 在指定位置插入新页
- extract_style: 提取 PPTX 的主题样式

每次编辑前自动备份原文件。`,
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '要编辑的 PPTX 文件路径',
      },
      action: {
        type: 'string',
        enum: ['replace_title', 'replace_content', 'replace_slide', 'delete_slide', 'insert_slide', 'extract_style'],
        description: '编辑操作类型',
      },
      slide_index: {
        type: 'number',
        description: '目标幻灯片索引（从 0 开始）',
      },
      content: {
        type: 'string',
        description: '替换的文本内容',
      },
      title: {
        type: 'string',
        description: '新标题（用于 replace_title 和 insert_slide）',
      },
      points: {
        type: 'array',
        items: { type: 'string' },
        description: '要点列表（用于 replace_content、replace_slide、insert_slide）',
      },
    },
    required: ['file_path', 'action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const {
      file_path,
      action,
      slide_index,
      content,
      title,
      points,
    } = params as unknown as PPTEditParams;

    if (!fs.existsSync(file_path)) {
      return { success: false, error: `文件不存在: ${file_path}` };
    }

    try {
      const JSZip = require('jszip');

      // Backup before edit
      const backupPath = file_path.replace(/\.pptx$/i, `.backup-${Date.now()}.pptx`);
      fs.copyFileSync(file_path, backupPath);

      const data = fs.readFileSync(file_path);
      const zip = await JSZip.loadAsync(data);

      let resultMessage = '';

      switch (action) {
        case 'replace_title': {
          if (slide_index === undefined) {
            return { success: false, error: 'replace_title 需要 slide_index 参数' };
          }
          const slideFile = `ppt/slides/slide${slide_index + 1}.xml`;
          if (!zip.files[slideFile]) {
            return { success: false, error: `幻灯片 ${slide_index} 不存在` };
          }
          let xml = await zip.files[slideFile].async('string');
          // Replace title in the first <a:p> within <p:txBody> of a title shape
          const newTitle = title || content || '';
          xml = replaceFirstTextRun(xml, newTitle, true);
          zip.file(slideFile, xml);
          resultMessage = `已替换第 ${slide_index + 1} 页标题为: "${newTitle}"`;
          break;
        }

        case 'replace_content': {
          if (slide_index === undefined) {
            return { success: false, error: 'replace_content 需要 slide_index 参数' };
          }
          const slideFile = `ppt/slides/slide${slide_index + 1}.xml`;
          if (!zip.files[slideFile]) {
            return { success: false, error: `幻灯片 ${slide_index} 不存在` };
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
            return { success: false, error: 'replace_slide 需要 slide_index 参数' };
          }
          const slideFile = `ppt/slides/slide${slide_index + 1}.xml`;
          if (!zip.files[slideFile]) {
            return { success: false, error: `幻灯片 ${slide_index} 不存在` };
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
            return { success: false, error: 'delete_slide 需要 slide_index 参数' };
          }
          const slideFile = `ppt/slides/slide${slide_index + 1}.xml`;
          const relFile = `ppt/slides/_rels/slide${slide_index + 1}.xml.rels`;
          if (!zip.files[slideFile]) {
            return { success: false, error: `幻灯片 ${slide_index} 不存在` };
          }
          zip.remove(slideFile);
          if (zip.files[relFile]) zip.remove(relFile);

          // Update presentation.xml to remove the slide reference
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
          // For insert, we inform the user to use ppt_generate instead
          // Direct XML insertion is complex and error-prone
          resultMessage = '插入新幻灯片建议使用 ppt_generate 重新生成。当前支持在已有幻灯片上 replace_title / replace_content。';
          break;
        }

        case 'extract_style': {
          const { extractStyleFromPptx } = await import('./styleExtractor');
          const styleConfig = await extractStyleFromPptx(file_path);
          if (!styleConfig) {
            return { success: false, error: '无法提取样式，可能不是有效的 PPTX 文件' };
          }
          return {
            success: true,
            output: `已提取主题样式:

背景色: #${styleConfig.bgColor}
文字色: #${styleConfig.textPrimary}
强调色: #${styleConfig.accent}
标题字体: ${styleConfig.fontTitle}
正文字体: ${styleConfig.fontBody}
深色主题: ${styleConfig.isDark ? '是' : '否'}`,
            metadata: { styleConfig },
          };
        }
      }

      // Write modified file
      if ((action as string) !== 'extract_style') {
        const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        fs.writeFileSync(file_path, outputBuffer);
      }

      return {
        success: true,
        output: `${resultMessage}\n备份: ${backupPath}`,
        metadata: { backupPath, action, slideIndex: slide_index },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `PPT 编辑失败: ${error.message}`,
      };
    }
  },
};

// ============================================================================
// XML helpers
// ============================================================================

/**
 * Replace the first text run in the slide XML (typically the title)
 */
function replaceFirstTextRun(xml: string, newText: string, isTitle: boolean): string {
  const escaped = escapeXml(newText);
  // Find the first <a:t> tag content and replace it
  if (isTitle) {
    // Replace the text inside the first <p:txBody>...<a:t>...</a:t>
    let replaced = false;
    return xml.replace(/<a:t>([^<]*)<\/a:t>/g, (match, oldText) => {
      if (!replaced) {
        replaced = true;
        return `<a:t>${escaped}</a:t>`;
      }
      return match;
    });
  }
  return xml;
}

/**
 * Replace body content (non-title text) in slide XML
 */
function replaceBodyContent(xml: string, newContent: string): string {
  const escaped = escapeXml(newContent);
  const lines = escaped.split('\n');

  // Find all <a:t> tags after the first one (title) and replace them
  let count = 0;
  let lineIndex = 0;
  return xml.replace(/<a:t>([^<]*)<\/a:t>/g, (match) => {
    count++;
    if (count <= 1) return match; // Skip title
    if (lineIndex < lines.length) {
      return `<a:t>${lines[lineIndex++]}</a:t>`;
    }
    return `<a:t></a:t>`; // Clear excess text runs
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
