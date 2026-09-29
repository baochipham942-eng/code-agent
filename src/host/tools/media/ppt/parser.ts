// ============================================================================
// PPT 内容解析器 - Markdown → SlideData
// ============================================================================

import type { SlideData } from './types';
import { DEFAULT_END_TITLE } from './constants';

/**
 * 解析 Markdown 内容为幻灯片数据
 */
export function parseContentToSlides(content: string, maxSlides: number): SlideData[] {
  const slides: SlideData[] = [];
  const lines = content.split('\n');

  let currentSlide: SlideData | null = null;
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeContent: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 代码块处理
    if (trimmed.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = trimmed.slice(3).trim() || 'text';
        codeContent = [];
      } else {
        inCodeBlock = false;
        if (currentSlide) {
          currentSlide.code = { language: codeLanguage, content: codeContent.join('\n') };
        }
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent.push(line);
      continue;
    }

    // 一级标题 - 新幻灯片
    if (trimmed.startsWith('# ')) {
      if (currentSlide) slides.push(currentSlide);
      const title = trimmed.replace(/^#\s*/, '');
      currentSlide = {
        title,
        points: [],
        isTitle: slides.length === 0,
        isEnd: /谢谢|感谢|Thank|Q&A|总结$/i.test(title),
      };
    }
    // 二级标题处理
    else if (trimmed.startsWith('## ')) {
      const subTitle = trimmed.replace(/^##\s*/, '');
      if (currentSlide && currentSlide.isTitle && !currentSlide.subtitle) {
        // 封面页：设为副标题
        currentSlide.subtitle = subTitle;
      } else if (currentSlide && !currentSlide.isTitle) {
        // 非封面页：作为加粗要点添加到内容中
        currentSlide.points.push(`**${subTitle}**`);
      }
    }
    // 列表项
    else if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.match(/^\d+\.\s/)) {
      if (currentSlide) {
        const text = trimmed.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '');
        currentSlide.points.push(text);
      }
    }
    // 普通文本行
    else if (trimmed && currentSlide && !currentSlide.isTitle) {
      currentSlide.points.push(trimmed);
    }
  }

  if (currentSlide) slides.push(currentSlide);

  // 确保至少有内容
  if (slides.length === 0) {
    slides.push({
      title: '内容概述',
      points: content.split('\n').filter(l => l.trim()).slice(0, 5),
    });
  }

  return slides.slice(0, maxSlides);
}

/**
 * 无内容时的空大纲骨架：仅封面（标题=主题）+ 结构性页标题 + 结尾页，不含任何数字、
 * 领域断言或示例要点（points 为空）。
 * 仅供设计 tab「生成大纲 → 用户编辑 → 出稿」这类用户会看到并改写骨架的路径；
 * ppt_generate 工具不得用它交付（此前写死的示例内容曾被当成成品交给用户）。
 */
export function outlineToSlideData(topic: string, count: number): SlideData[] {
  const slides: SlideData[] = [{ title: topic, points: [], isTitle: true }];

  const sectionTitles = ['背景', '问题', '方案', '价值', '落地', '总结'];
  const actualCount = Math.max(0, Math.min(count - 2, sectionTitles.length));
  for (let i = 0; i < actualCount; i++) {
    slides.push({ title: sectionTitles[i], points: [] });
  }

  slides.push({
    title: DEFAULT_END_TITLE,
    points: [],
    isEnd: true,
  });

  return slides;
}
