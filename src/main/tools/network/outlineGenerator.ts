// ============================================================================
// Outline Generator - 基于 SCQA + 金字塔原理的大纲生成器
// 参考：Writing Path (NAACL 2025) + McKinsey SCQA Framework
// ============================================================================

/**
 * 大纲章节类型（基于 SCQA 框架）
 */
export type SectionType =
  | 'situation'     // S - 背景/现状
  | 'complication'  // C - 问题/挑战
  | 'question'      // Q - 核心问题（通常隐含）
  | 'answer'        // A - 解决方案（主体内容）
  | 'evidence';     // 支撑证据/数据

/**
 * 章节布局提示
 */
export type LayoutHint = 'stats' | 'timeline' | 'cards' | 'list' | 'highlight' | 'comparison';

/**
 * 大纲章节定义
 */
export interface OutlineSection {
  id: string;
  type: SectionType;
  title: string;
  layoutHint: LayoutHint;
  searchQuery?: string;      // 用于搜索的查询词
  dataSlots: DataSlot[];     // 需要填充的数据槽
  points?: string[];         // 填充后的具体内容
}

/**
 * 数据槽 - 需要从搜索结果中提取的信息
 */
export interface DataSlot {
  id: string;
  description: string;       // 描述需要什么数据
  type: 'number' | 'fact' | 'comparison' | 'quote' | 'list';
  required: boolean;
  value?: string;            // 填充的值
}

/**
 * 完整大纲结构
 */
export interface Outline {
  topic: string;
  title: string;
  subtitle?: string;
  sections: OutlineSection[];
  metadata: {
    generatedAt: string;
    framework: 'SCQA';
    totalSlides: number;
  };
}

// ============================================================================
// 主题模板库 - 不同类型主题的大纲结构
// ============================================================================

interface TopicTemplate {
  pattern: RegExp;
  category: string;
  sections: Omit<OutlineSection, 'id' | 'points'>[];
}

const TOPIC_TEMPLATES: TopicTemplate[] = [
  // 产品/工具介绍
  {
    pattern: /产品|工具|软件|平台|系统|App|应用|Claude|GPT|AI助手/i,
    category: 'product',
    sections: [
      {
        type: 'situation',
        title: '行业背景',
        layoutHint: 'highlight',
        searchQuery: '{topic} 行业现状 市场规模 2026',
        dataSlots: [
          { id: 's1', description: '市场规模或增长率', type: 'number', required: true },
          { id: 's2', description: '行业痛点或需求', type: 'fact', required: true },
        ],
      },
      {
        type: 'answer',
        title: '核心价值',
        layoutHint: 'highlight',
        searchQuery: '{topic} 优势 价值 解决什么问题',
        dataSlots: [
          { id: 'v1', description: '核心价值主张（一句话）', type: 'fact', required: true },
          { id: 'v2', description: '与竞品的关键差异', type: 'comparison', required: false },
        ],
      },
      {
        type: 'evidence',
        title: '行业数据',
        layoutHint: 'stats',
        searchQuery: '{topic} 性能 数据 评测 benchmark 排名',
        dataSlots: [
          { id: 'd1', description: '核心性能指标1', type: 'number', required: true },
          { id: 'd2', description: '核心性能指标2', type: 'number', required: true },
          { id: 'd3', description: '用户规模或市场数据', type: 'number', required: false },
          { id: 'd4', description: '对比数据', type: 'comparison', required: false },
        ],
      },
      {
        type: 'answer',
        title: '功能特性',
        layoutHint: 'list',
        searchQuery: '{topic} 功能 特性 能力 feature',
        dataSlots: [
          { id: 'f1', description: '核心功能1', type: 'fact', required: true },
          { id: 'f2', description: '核心功能2', type: 'fact', required: true },
          { id: 'f3', description: '核心功能3', type: 'fact', required: true },
          { id: 'f4', description: '核心功能4', type: 'fact', required: false },
          { id: 'f5', description: '核心功能5', type: 'fact', required: false },
        ],
      },
      {
        type: 'answer',
        title: '技术架构',
        layoutHint: 'cards',
        searchQuery: '{topic} 架构 技术 原理 实现',
        dataSlots: [
          { id: 'a1', description: '核心架构/算法', type: 'fact', required: true },
          { id: 'a2', description: '关键技术点1', type: 'fact', required: true },
          { id: 'a3', description: '关键技术点2', type: 'fact', required: false },
        ],
      },
      {
        type: 'evidence',
        title: '应用效果',
        layoutHint: 'stats',
        searchQuery: '{topic} 案例 效果 用户 评价',
        dataSlots: [
          { id: 'e1', description: '效率提升数据', type: 'number', required: true },
          { id: 'e2', description: '用户评价或案例', type: 'quote', required: false },
          { id: 'e3', description: '知名客户', type: 'list', required: false },
        ],
      },
    ],
  },

  // 技术分享/教程
  {
    pattern: /技术|教程|实现|开发|编程|代码|框架|库|SDK|API/i,
    category: 'technical',
    sections: [
      {
        type: 'situation',
        title: '背景与动机',
        layoutHint: 'highlight',
        searchQuery: '{topic} 为什么 背景 问题',
        dataSlots: [
          { id: 's1', description: '要解决的问题', type: 'fact', required: true },
          { id: 's2', description: '现有方案的不足', type: 'fact', required: false },
        ],
      },
      {
        type: 'answer',
        title: '核心概念',
        layoutHint: 'cards',
        searchQuery: '{topic} 概念 原理 定义',
        dataSlots: [
          { id: 'c1', description: '核心概念定义', type: 'fact', required: true },
          { id: 'c2', description: '关键术语1', type: 'fact', required: true },
          { id: 'c3', description: '关键术语2', type: 'fact', required: false },
        ],
      },
      {
        type: 'answer',
        title: '实现步骤',
        layoutHint: 'timeline',
        searchQuery: '{topic} 步骤 流程 如何实现',
        dataSlots: [
          { id: 'p1', description: '步骤1', type: 'fact', required: true },
          { id: 'p2', description: '步骤2', type: 'fact', required: true },
          { id: 'p3', description: '步骤3', type: 'fact', required: true },
          { id: 'p4', description: '步骤4', type: 'fact', required: false },
        ],
      },
      {
        type: 'evidence',
        title: '代码示例',
        layoutHint: 'list',
        searchQuery: '{topic} 代码 示例 example',
        dataSlots: [
          { id: 'x1', description: '关键代码片段', type: 'fact', required: true },
        ],
      },
      {
        type: 'answer',
        title: '最佳实践',
        layoutHint: 'list',
        searchQuery: '{topic} 最佳实践 注意事项 技巧',
        dataSlots: [
          { id: 'b1', description: '最佳实践1', type: 'fact', required: true },
          { id: 'b2', description: '最佳实践2', type: 'fact', required: true },
          { id: 'b3', description: '常见错误', type: 'fact', required: false },
        ],
      },
    ],
  },

  // 商业/战略汇报
  {
    pattern: /商业|战略|市场|分析|报告|汇报|业务|运营/i,
    category: 'business',
    sections: [
      {
        type: 'situation',
        title: '市场现状',
        layoutHint: 'stats',
        searchQuery: '{topic} 市场规模 现状 数据 2026',
        dataSlots: [
          { id: 's1', description: '市场规模', type: 'number', required: true },
          { id: 's2', description: '增长趋势', type: 'number', required: true },
        ],
      },
      {
        type: 'complication',
        title: '挑战与机遇',
        layoutHint: 'cards',
        searchQuery: '{topic} 挑战 机遇 趋势',
        dataSlots: [
          { id: 'c1', description: '主要挑战', type: 'fact', required: true },
          { id: 'c2', description: '市场机遇', type: 'fact', required: true },
        ],
      },
      {
        type: 'answer',
        title: '战略方向',
        layoutHint: 'highlight',
        searchQuery: '{topic} 战略 方向 建议',
        dataSlots: [
          { id: 'a1', description: '核心战略', type: 'fact', required: true },
        ],
      },
      {
        type: 'answer',
        title: '实施路径',
        layoutHint: 'timeline',
        searchQuery: '{topic} 实施 计划 步骤',
        dataSlots: [
          { id: 'p1', description: '阶段1', type: 'fact', required: true },
          { id: 'p2', description: '阶段2', type: 'fact', required: true },
          { id: 'p3', description: '阶段3', type: 'fact', required: true },
        ],
      },
      {
        type: 'evidence',
        title: '预期效果',
        layoutHint: 'stats',
        searchQuery: '{topic} 效果 ROI 收益',
        dataSlots: [
          { id: 'e1', description: '预期收益', type: 'number', required: true },
          { id: 'e2', description: '关键指标', type: 'number', required: false },
        ],
      },
    ],
  },

  // 通用模板（默认）
  {
    pattern: /.*/,
    category: 'general',
    sections: [
      {
        type: 'situation',
        title: '背景介绍',
        layoutHint: 'highlight',
        searchQuery: '{topic} 是什么 背景 介绍',
        dataSlots: [
          { id: 's1', description: '背景说明', type: 'fact', required: true },
        ],
      },
      {
        type: 'answer',
        title: '核心内容',
        layoutHint: 'cards',
        searchQuery: '{topic} 核心 要点 重点',
        dataSlots: [
          { id: 'c1', description: '核心要点1', type: 'fact', required: true },
          { id: 'c2', description: '核心要点2', type: 'fact', required: true },
          { id: 'c3', description: '核心要点3', type: 'fact', required: false },
        ],
      },
      {
        type: 'answer',
        title: '详细分析',
        layoutHint: 'list',
        searchQuery: '{topic} 分析 详细 深入',
        dataSlots: [
          { id: 'a1', description: '分析点1', type: 'fact', required: true },
          { id: 'a2', description: '分析点2', type: 'fact', required: true },
          { id: 'a3', description: '分析点3', type: 'fact', required: false },
          { id: 'a4', description: '分析点4', type: 'fact', required: false },
        ],
      },
      {
        type: 'evidence',
        title: '案例/数据',
        layoutHint: 'stats',
        searchQuery: '{topic} 案例 数据 实例',
        dataSlots: [
          { id: 'e1', description: '关键数据', type: 'number', required: false },
          { id: 'e2', description: '案例说明', type: 'fact', required: false },
        ],
      },
      {
        type: 'answer',
        title: '总结展望',
        layoutHint: 'highlight',
        searchQuery: '{topic} 总结 未来 趋势',
        dataSlots: [
          { id: 't1', description: '核心总结', type: 'fact', required: true },
        ],
      },
    ],
  },
];

// ============================================================================
// 大纲生成器
// ============================================================================

/**
 * 根据主题生成大纲结构
 */
export function generateOutlineStructure(topic: string): Outline {
  // 匹配最合适的模板
  const template = TOPIC_TEMPLATES.find(t => t.pattern.test(topic)) || TOPIC_TEMPLATES[TOPIC_TEMPLATES.length - 1];

  // 生成章节
  const sections: OutlineSection[] = template.sections.map((section, index) => ({
    ...section,
    id: `section-${index + 1}`,
    searchQuery: section.searchQuery?.replace('{topic}', topic),
    points: [],
  }));

  return {
    topic,
    title: topic,
    subtitle: generateSubtitle(topic, template.category),
    sections,
    metadata: {
      generatedAt: new Date().toISOString(),
      framework: 'SCQA',
      totalSlides: sections.length + 2, // +2 for title and end slides
    },
  };
}

/**
 * 生成副标题
 */
function generateSubtitle(topic: string, category: string): string {
  const subtitles: Record<string, string[]> = {
    product: ['深度解析与实践指南', '功能特性与应用场景', '核心能力全景解读'],
    technical: ['原理剖析与最佳实践', '从入门到精通', '技术架构与实现详解'],
    business: ['市场洞察与战略建议', '数据驱动的深度分析', '机遇与挑战并存'],
    general: ['全面解读与深度分析', '核心要点与关键洞察', '系统性梳理与总结'],
  };

  const options = subtitles[category] || subtitles.general;
  return options[Math.floor(Math.random() * options.length)];
}

/**
 * 获取所有需要搜索的查询词
 */
export function getSearchQueries(outline: Outline): string[] {
  return outline.sections
    .filter(s => s.searchQuery)
    .map(s => s.searchQuery!);
}

/**
 * 将搜索结果填充到大纲
 */
export function fillOutlineWithData(
  outline: Outline,
  sectionId: string,
  data: Record<string, string>
): Outline {
  const updatedSections = outline.sections.map(section => {
    if (section.id !== sectionId) return section;

    // 填充数据槽
    const filledSlots = section.dataSlots.map(slot => ({
      ...slot,
      value: data[slot.id] || slot.value,
    }));

    // 生成 points
    const points = filledSlots
      .filter(slot => slot.value)
      .map(slot => slot.value!);

    return {
      ...section,
      dataSlots: filledSlots,
      points,
    };
  });

  return {
    ...outline,
    sections: updatedSections,
  };
}

/**
 * 将大纲转换为 Markdown 格式（供 ppt_generate 使用）
 */
export function outlineToMarkdown(outline: Outline): string {
  const lines: string[] = [];

  // 标题页
  lines.push(`# ${outline.title}`);
  if (outline.subtitle) {
    lines.push(`## ${outline.subtitle}`);
  }
  lines.push('');

  // 内容页
  for (const section of outline.sections) {
    lines.push(`# ${section.title}`);

    if (section.points && section.points.length > 0) {
      for (const point of section.points) {
        lines.push(`- ${point}`);
      }
    } else {
      // 如果没有填充内容，使用数据槽描述作为占位
      for (const slot of section.dataSlots.filter(s => s.required)) {
        lines.push(`- [待填充: ${slot.description}]`);
      }
    }
    lines.push('');
  }

  // 结束页
  lines.push('# 谢谢观看');

  return lines.join('\n');
}

/**
 * 生成搜索提示词（用于指导模型如何搜索）
 */
export function generateSearchPrompt(outline: Outline): string {
  const queries = getSearchQueries(outline);

  return `为了生成关于「${outline.topic}」的高质量 PPT，请依次搜索以下内容：

${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}

搜索时请注意：
- 优先获取 2025-2026 年的最新数据
- 提取具体数字（百分比、金额、数量等）
- 记录数据来源以确保可信度
- 关注行业对比和竞品数据`;
}

/**
 * 验证大纲完整性
 */
export function validateOutline(outline: Outline): {
  isComplete: boolean;
  missingSlots: { sectionId: string; slotId: string; description: string }[];
  completionRate: number;
} {
  const missingSlots: { sectionId: string; slotId: string; description: string }[] = [];
  let totalRequired = 0;
  let filledRequired = 0;

  for (const section of outline.sections) {
    for (const slot of section.dataSlots) {
      if (slot.required) {
        totalRequired++;
        if (slot.value) {
          filledRequired++;
        } else {
          missingSlots.push({
            sectionId: section.id,
            slotId: slot.id,
            description: slot.description,
          });
        }
      }
    }
  }

  return {
    isComplete: missingSlots.length === 0,
    missingSlots,
    completionRate: totalRequired > 0 ? filledRequired / totalRequired : 1,
  };
}
