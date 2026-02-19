// ============================================================================
// 内容生成提醒 - PPT / 数据处理 / 文档 / 图像 / 视频
// ============================================================================

import type { ReminderDefinition } from './types';

/**
 * 内容生成与任务类型选择提醒（Priority 1）
 */
export const CONTENT_GENERATION_REMINDERS: ReminderDefinition[] = [
  {
    id: 'PPT_FORMAT_SELECTION',
    priority: 1,
    content: `<system-reminder>
**PPT 生成必须遵循的流程**：

**第一步：收集信息（必须）**
- 如果是介绍本地项目/产品 → 先用 read_file 读取 package.json、README.md、CLAUDE.md
- 如果是通用主题 → 先用 web_search 搜索最新数据

**第二步：内容规范**
- 每页 4-5 个要点，每个要点 20-40 字
- 内容要具体：包含真实数据、功能名称、技术细节
- 禁止编造虚假数据

**第三步：图表控制**
- 包含数字/百分比的数据内容会自动生成原生可编辑图表（chart_mode: auto）
- 复杂流程图可用 mermaid_export 生成透明 PNG，传入 images 参数
- 10 页 PPT 最多 1-2 张流程图，大部分页面用文字列表即可
</system-reminder>`,
    tokens: 250,
    shouldInclude: (ctx) => ctx.taskFeatures.isPPTTask ? 1.0 : 0,
    exclusiveGroup: 'task-type-selection',
    category: 'tool',
  },
  {
    id: 'DATA_PROCESSING_WORKFLOW',
    priority: 1,
    content: `<system-reminder>
**数据处理必须遵循的流程**：

**第一步：读取数据（必须）**
- 用 read_xlsx/read_file 读取源数据，确认列名、数据类型、行数
- 不要猜测数据结构，必须先看数据

**第二步：处理规范**
- 时序分析：pd.to_datetime + set_index，确保日期索引正确
- 聚合统计：明确分组键和聚合函数，验证结果行数
- 空值处理：显式 dropna/fillna，不忽略 NaN

**第三步：输出验证**
- 输出文件后检查：文件 >1KB、无全空列、行数合理
- 必须用文字描述关键发现（不能只输出文件路径）
- 模糊指令先用 ask_user_question 澄清
</system-reminder>`,
    tokens: 200,
    shouldInclude: (ctx) => ctx.taskFeatures.isDataTask ? 1.0 : 0,
    exclusiveGroup: 'task-type-selection',
    category: 'tool',
  },
  {
    id: 'DOCUMENT_GENERATION_WORKFLOW',
    priority: 1,
    content: `<system-reminder>
**文档生成必须遵循的流程**：

**第一步：收集素材**
- 如有参考文件 → read_file/read_pdf 读取
- 如需最新数据 → web_search 搜索

**第二步：内容规范**
- 清晰的标题层级（# / ## / ###）
- 内容具体，不留占位符（[TODO]、[待填写]）
- 数据/案例必须真实或标注为示例

**第三步：输出检查**
- 长度与任务复杂度匹配
- 无遗留占位符文本
</system-reminder>`,
    tokens: 150,
    shouldInclude: (ctx) => ctx.taskFeatures.isDocumentTask ? 1.0 : 0,
    exclusiveGroup: 'task-type-selection',
    category: 'tool',
  },
  {
    id: 'IMAGE_GENERATION_WORKFLOW',
    priority: 1,
    content: `<system-reminder>
**图像生成必须遵循的流程**：

**工具选择**：
- 流程图/时序图 → mermaid_export（输出 PNG，加 ?type=png）
- 照片/插图 → image_generate
- 数据图表 → bash 执行 Python matplotlib
- 简单 SVG → write_file

**输出验证**：
- 确认文件存在且 >1KB
- 验证文件格式正确（PNG/JPEG/SVG）
</system-reminder>`,
    tokens: 120,
    shouldInclude: (ctx) => ctx.taskFeatures.isImageTask ? 1.0 : 0,
    exclusiveGroup: 'task-type-selection',
    category: 'tool',
  },
  {
    id: 'VIDEO_GENERATION_WORKFLOW',
    priority: 1,
    content: `<system-reminder>
**视频生成必须遵循的流程**：

**第一步：理解需求**
- 确认视频主题、风格、时长、画面比例
- 描述越具体效果越好（场景、运镜、光照、色调）

**第二步：调用 video_generate**
- prompt: 详细的视频描述
- aspect_ratio: 16:9（横屏）/ 9:16（竖屏）/ 1:1
- duration: 5 或 10 秒
- quality: "quality"（高质量）或 "speed"（快速）
- 可选 image_url 做图生视频

**第三步：等待与验证**
- 异步任务最长约 5 分钟，等待完成后告知用户
- 不要在生成完成前就说"已完成"
</system-reminder>`,
    tokens: 180,
    shouldInclude: (ctx) => ctx.taskFeatures.isVideoTask ? 1.0 : 0,
    exclusiveGroup: 'task-type-selection',
    category: 'tool',
  },
];
