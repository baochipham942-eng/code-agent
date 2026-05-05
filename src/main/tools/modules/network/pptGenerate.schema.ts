// Schema-only file (P0-7 方案 A — single source of truth)
// ppt_generate — legacy v7 工作流，inputSchema 与字段需 1:1 复刻 legacy（评测契约）
import type { ToolSchema } from '../../../protocol/tools';

const LEGACY_PPT_GENERATE_ENV = 'ENABLE_LEGACY_PPT_GENERATE';

export const pptGenerateSchema: ToolSchema = {
  name: 'ppt_generate',
  description: `遗留 PowerPoint 生成器（v7 工作流，默认禁用）。

默认请改用 frontend-slides skill 或 /ppt 兼容入口。
只有在显式设置环境变量 ${LEGACY_PPT_GENERATE_ENV}=1 时才允许继续执行。

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
      fallback_on_design_failure: {
        type: 'boolean',
        description: 'mode=design 失败时是否降级到 v7 generate。默认 false，避免把 Design Mode 失败伪装成普通生成成功。',
        default: false,
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
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};

export { LEGACY_PPT_GENERATE_ENV };
