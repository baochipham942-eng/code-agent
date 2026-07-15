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

**第一步：先落骨架，不要先调研，也不要先问需求**
- 直接给一版大纲骨架，把你的假设摆明（「不对就说」），让对方在骨架上改
- **用途、受众、页数、风格一律先按常见做法假设，不要用 AskUserQuestion 问**——对方看到
  骨架自己会纠正，这比先问一轮快
- 缺的数字标「示例数据，待替换」，既不编造，也不为了凑齐信息卡着不动
- **只有内容依赖你不可能知道的事实时才先查**：介绍对方自己的项目/产品 → 先读他给的材料
  （附件、说明文档；如果是代码库则读 README）；主题依赖时效数据 → WebSearch

**第二步：内容规范**
- 每页 4-5 个要点，每个要点 20-40 字
- 内容要具体：包含真实数据、功能名称、技术细节
- 禁止编造虚假数据

**第三步：图表控制**
- 包含数字/百分比的数据内容会自动生成原生可编辑图表（chart_mode: auto）
- 复杂流程图可用 mermaid_export 生成透明 PNG，传入 images 参数
- 10 页 PPT 最多 1-2 张流程图，大部分页面用文字列表即可
</system-reminder>`,
    tokens: 350,
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
- Excel 文件用 ExcelAutomate(read)，普通文本/CSV 用 Read 或 Bash+pandas，先确认列名、数据类型、行数
- 不要猜测数据结构，必须先看数据

**第二步：处理规范**
- 时序分析：pd.to_datetime + set_index，确保日期索引正确
- 聚合统计：明确分组键和聚合函数，验证结果行数
- 空值处理：显式 dropna/fillna，不忽略 NaN

**第三步：输出验证**
- 输出文件后检查：文件 >1KB、无全空列、行数合理
- 必须用文字描述关键发现（不能只输出文件路径）
- 模糊指令先用 AskUserQuestion 澄清
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

**第一步：先出初稿，不要先收集，也不要先问需求**
- 直接写一版完整初稿，对方在初稿上改比从空白开始快；结构、篇幅、口吻先按常见做法假设并写明
  （「不对就说」），不要用 AskUserQuestion 先问
- 有参考文件才 Read/read_pdf 读；主题依赖时效数据才 WebSearch。都没有就按常见结构直接写

**第二步：内容规范**
- 清晰的标题层级（# / ## / ###）
- 内容具体，不留占位符（[TODO]、[待填写]）
- 数据/案例必须真实或标注为示例

**第三步：输出检查**
- 长度与任务复杂度匹配
- 无遗留占位符文本
</system-reminder>`,
    tokens: 215,
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
- 简单 SVG → Write

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
  {
    id: 'EXCEL_DATA_WORKFLOW',
    priority: 1,
    content: `<system-reminder>
**Excel 数据处理必须遵循的流程**：

**第一步：全局概览（必须，用一次工具调用完成）**
- 用 Python openpyxl 一次性获取：所有 sheet 名称、各 sheet 维度（行列数）、表头
- 示例：\`for s in wb.sheetnames: ws=wb[s]; print(f"{s}: {ws.max_row}x{ws.max_column}, headers={[c.value for c in ws[1]]}")\`
- 禁止硬编码列名/sheet 名，必须从概览中获取

**第二步：处理规范（优先用公式，其次用安全的 Python）**
- **优先 Excel 公式**：SUM/SUMIF/INDEX/MATCH/VLOOKUP 等原生公式比 Python 循环更可靠、更快
- **必须用 Python 时**：cell.value 类型不可预测（可能是 str/None/int/float），算术前必须转换：
  \`val = float(cell.value) if cell.value is not None else 0\`
- 去重：用 subset 指定主键列
- 聚合：用 groupby + agg 明确分组键和聚合函数
- **批量操作**：一次写入所有目标单元格，然后一次 save，不要循环中反复 save

**第三步：输出验证**
- 检查 sheet 数量、列名、数据行数是否符合预期
- 确认无全空列、无数据丢失
- 输出关键数据摘要（行数、汇总值）供用户确认
</system-reminder>`,
    tokens: 300,
    shouldInclude: (ctx) => ctx.taskFeatures.isExcelTask ? 1.0 : 0,
    exclusiveGroup: 'task-type-selection',
    category: 'tool',
  },
];
