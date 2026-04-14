// ============================================================================
// PPT Mermaid 自动处理
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { SlideImage } from './types';
import { MERMAID_INK_API } from '../../../../shared/constants';

function base64UrlEncode(str: string): string {
  const base64 = Buffer.from(str).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 自动检测内容中的 mermaid 代码块，渲染为 PNG 图片
 */
export async function autoProcessMermaid(
  content: string,
  outputDir: string,
  context: { emit?: (event: string, data: unknown) => void }
): Promise<{ content: string; images: SlideImage[] }> {
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;
  const images: SlideImage[] = [];
  let processedContent = content;
  let mermaidIndex = 0;

  const lines = content.split('\n');
  let currentSlide = -1;
  const mermaidPositions: { slideIndex: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('# ')) currentSlide++;
    if (lines[i].trim() === '```mermaid') {
      mermaidPositions.push({ slideIndex: currentSlide });
    }
  }

  let match;
  while ((match = mermaidRegex.exec(content)) !== null) {
    const mermaidCode = match[1].trim();
    const position = mermaidPositions[mermaidIndex];

    try {
      context.emit?.('tool_output', {
        tool: 'ppt_generate',
        message: `Rendering Mermaid chart ${mermaidIndex + 1}...`,
      });

      const mermaidConfig = { code: mermaidCode, mermaid: { theme: 'dark' } };
      const encodedConfig = base64UrlEncode(JSON.stringify(mermaidConfig));
      const renderUrl = `${MERMAID_INK_API}/img/${encodedConfig}?bgColor=transparent&scale=2`;

      const response = await fetch(renderUrl);
      if (response.ok) {
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        const imagePath = path.join(outputDir, `mermaid-${Date.now()}-${mermaidIndex}.png`);
        fs.writeFileSync(imagePath, imageBuffer);

        images.push({
          slide_index: position?.slideIndex ?? mermaidIndex + 1,
          image_path: imagePath,
          position: 'center',
        });

        processedContent = processedContent.replace(match[0], '[图表已渲染]');
      }
    } catch (error) {
      console.error('Mermaid render failed:', error);
    }

    mermaidIndex++;
  }

  return { content: processedContent, images };
}
