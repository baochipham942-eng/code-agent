// ============================================================================
// PPT 预览摘要 - 输出 Markdown 格式的逐页摘要
// ============================================================================

import type { SlideData } from './types';
import { PREVIEW_CODE_TRUNCATE } from './constants';

/**
 * Generate a Markdown preview summary of the presentation
 * without generating the actual PPTX file.
 *
 * @param slides - Parsed slide data
 * @returns Markdown formatted preview string
 */
export function generateSlidePreview(slides: SlideData[]): string {
  const lines: string[] = [];
  lines.push('# PPT 预览摘要');
  lines.push('');
  lines.push(`共 ${slides.length} 张幻灯片`);
  lines.push('');

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const slideNum = i + 1;

    // Slide header with type indicator
    let typeTag = '';
    if (slide.isTitle) typeTag = ' [封面]';
    else if (slide.isEnd) typeTag = ' [结束]';

    lines.push(`## Slide ${slideNum}${typeTag}`);
    lines.push('');

    // Title
    lines.push(`**${slide.title}**`);

    // Subtitle
    if (slide.subtitle) {
      lines.push(`*${slide.subtitle}*`);
    }

    // Points
    if (slide.points.length > 0) {
      lines.push('');
      for (const point of slide.points) {
        lines.push(`- ${point}`);
      }
    }

    // Code block
    if (slide.code) {
      lines.push('');
      lines.push(`\`\`\`${slide.code.language}`);
      lines.push(slide.code.content.slice(0, PREVIEW_CODE_TRUNCATE));
      if (slide.code.content.length > PREVIEW_CODE_TRUNCATE) lines.push('...');
      lines.push('```');
    }

    // Table
    if (slide.table) {
      lines.push('');
      lines.push(`| ${slide.table.headers.join(' | ')} |`);
      lines.push(`| ${slide.table.headers.map(() => '---').join(' | ')} |`);
      for (const row of slide.table.rows.slice(0, 3)) {
        lines.push(`| ${row.join(' | ')} |`);
      }
      if (slide.table.rows.length > 3) {
        lines.push(`*... ${slide.table.rows.length - 3} more rows*`);
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
