// ============================================================================
// PPT 内容解析器 - Markdown → SlideData
// ============================================================================

import type { SlideData } from './types';

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
 * 生成丰富的占位内容
 */
export function generatePlaceholderSlides(topic: string, count: number): SlideData[] {
  const slides: SlideData[] = [
    {
      title: topic,
      subtitle: '深度解析与实践指南',
      points: [],
      isTitle: true,
    },
  ];

  const sections = [
    {
      title: '核心价值',
      points: [
        '解决行业痛点：提升 80% 开发效率，减少重复劳动',
        '技术领先优势：采用最新 AI 架构，性能超越同类产品',
        '用户价值：降低学习成本，快速上手即可产出成果',
        '生态完善：丰富的插件和集成，满足多样化需求',
      ],
    },
    {
      title: '功能特性',
      points: [
        '智能代码生成：根据自然语言描述自动生成高质量代码',
        '上下文理解：200K token 上下文窗口，理解完整项目',
        '多模态支持：可分析截图、架构图、设计稿等图片',
        '工具集成：内置 20+ 开发工具，覆盖完整工作流',
      ],
    },
    {
      title: '技术架构',
      points: [
        'Agent Loop 架构：用户输入 → 模型推理 → 工具执行 → 结果反馈',
        '安全沙箱：所有代码在受限环境执行，保障系统安全',
        '流式响应：实时显示思考过程，提升用户体验',
        '可扩展设计：支持 MCP 协议，可连接外部服务',
      ],
    },
    {
      title: '应用场景',
      points: [
        '代码重构：批量修改代码风格，迁移框架版本',
        'Bug 修复：根据错误日志自动定位并修复问题',
        '新功能开发：端到端实现完整功能模块',
        '代码审查：自动检测安全漏洞和性能问题',
      ],
    },
    {
      title: '使用效果',
      points: [
        '效率提升：平均节省 60% 编码时间',
        '质量保证：代码通过率提升 40%',
        '学习曲线：新手 30 分钟即可上手',
        '用户满意度：NPS 评分达到 72 分',
      ],
    },
  ];

  const actualCount = Math.min(count - 2, sections.length);
  for (let i = 0; i < actualCount; i++) {
    slides.push(sections[i]);
  }

  slides.push({
    title: '谢谢观看',
    points: [],
    isEnd: true,
  });

  return slides;
}
