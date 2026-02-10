// ============================================================================
// System Reminders - 动态系统提醒（借鉴 Claude Code）
// ============================================================================
// Claude Code 有 40 个动态系统提醒，按需注入
// 这避免了所有规则同时竞争模型注意力
// ============================================================================

/**
 * 系统提醒类型
 */
export type ReminderType =
  | 'PARALLEL_DISPATCH'
  | 'MUST_DELEGATE'
  | 'PLAN_MODE_ACTIVE'
  | 'AUDIT_MODE'
  | 'REVIEW_MODE'
  | 'PPT_FORMAT_SELECTION'
  | 'DATA_PROCESSING'
  | 'DOCUMENT_GENERATION'
  | 'IMAGE_GENERATION'
  | 'VIDEO_GENERATION'
  | 'CODE_REVIEW_DIAGNOSIS'
  | 'SYSTEM_TROUBLESHOOTING';

/**
 * 系统提醒内容
 */
export const REMINDERS: Record<ReminderType, string> = {
  /**
   * 多维度任务 - 并行派发提醒
   */
  PARALLEL_DISPATCH: `
<system-reminder>
**并行派发提醒**：检测到多维度任务。

你应该在**单个响应中同时派发多个 task**，而不是逐个执行：

\`\`\`
task(subagent_type="code-review", prompt="维度1: ...")
task(subagent_type="explore", prompt="维度2: ...")
task(subagent_type="code-review", prompt="维度3: ...")
\`\`\`

各维度之间无依赖关系时，并行派发能显著提高效率。
</system-reminder>
`,

  /**
   * 复杂任务 - 必须委派提醒
   */
  MUST_DELEGATE: `
<system-reminder>
**委派提醒**：这是一个需要广泛探索的复杂任务。

请使用 task 工具委派给子代理，子代理有专门的工具和上下文窗口，比直接执行更高效。

不要直接使用 glob/grep/read_file，而应该：
- 安全审计 → task(subagent_type="code-review", prompt="...")
- 代码探索 → task(subagent_type="explore", prompt="...")
- 架构分析 → task(subagent_type="plan", prompt="...")
</system-reminder>
`,

  /**
   * 规划模式激活提醒
   */
  PLAN_MODE_ACTIVE: `
<system-reminder>
**Plan Mode 已激活**：你现在处于只读规划模式。

5-Phase 流程：
1. Phase 1: 并行派发 explore 子代理探索代码库
2. Phase 2: 派发 plan 子代理设计方案
3. Phase 3: 整合结果，使用 ask_user_question 澄清
4. Phase 4: 生成最终计划
5. Phase 5: 调用 exit_plan_mode（必须用工具调用）

**禁止**：在 Plan Mode 中进行任何文件写入操作。
</system-reminder>
`,

  /**
   * 审计模式提醒
   */
  AUDIT_MODE: `
<system-reminder>
**审计模式**：检测到安全/代码审计任务。

推荐流程：
1. 并行派发多个 code-review 子代理，每个负责一个维度
2. 收集所有子代理的审计结果
3. 整合生成完整审计报告

审计维度示例：认证授权、输入验证、数据安全、依赖安全、配置安全
</system-reminder>
`,

  /**
   * 代码审查模式提醒
   */
  REVIEW_MODE: `
<system-reminder>
**审查模式**：检测到代码审查任务。

推荐流程：
1. 先用 bash 获取变更文件列表（git diff --name-only）
2. 并行派发 code-review 子代理分析不同方面
3. 整合生成审查报告

审查维度示例：代码质量、潜在问题、性能考量、安全性、可维护性
</system-reminder>
`,

  /**
   * PPT 生成工作流（简化版，不强制询问）
   */
  PPT_FORMAT_SELECTION: `
<system-reminder>
**PPT 生成任务**：检测到演示文稿生成需求。

**输出格式**：PPTX 文件（可用 PowerPoint/WPS/Keynote 打开编辑）

**工作流程**：
1. 如有本地文档素材 → 使用 read_pdf/read_file 读取
2. 如需图表 → 使用 mermaid_export 生成 PNG 图片
3. 如需配图 → 使用 image_generate 生成
4. 最后调用 ppt_generate 生成 PPTX，通过 images 参数嵌入图片

**ppt_generate 调用示例**：
\`\`\`
ppt_generate({
  topic: "标题",
  content: "# 封面\\n## 副标题\\n# 第一章\\n- 要点1\\n- 要点2",
  theme: "dracula",  // 或 tech/professional/corporate
  images: [{ slide_index: 1, image_path: "/path/chart.png", position: "center" }]
})
\`\`\`

**主题选择**：
- 技术分享 → dracula（暗色科技风）
- 产品介绍 → professional（商务蓝白）
- 企业汇报 → corporate（企业正式）
- 其他 → tech（深蓝科技风）

**禁止**：
- ❌ 不要用 write_file 生成 slides.md（用户要的是 PPTX）
- ❌ 不要把 Mermaid 代码直接放到 content 里（必须先用 mermaid_export 转 PNG）
</system-reminder>
`,

  DATA_PROCESSING: `
<system-reminder>
**数据处理任务**：检测到数据分析/处理需求。

**工作流程**：
1. 先用 read_xlsx/read_file 读取源数据，了解结构（列名、数据类型、行数）
2. 分析需求，确定处理逻辑（筛选/聚合/透视/时序分析等）
3. 用 bash 执行 Python/pandas 脚本处理数据
4. 输出结果到指定格式（xlsx/csv），并描述关键发现

**关键规范**：
- 先读数据再写代码，不要猜测列名和数据格式
- 时序分析必须正确设置日期索引（pd.to_datetime + set_index）
- 聚合统计结果要验证：行数、空列、数值合理性
- 模糊指令（如"分析一下"）→ 先用 ask_user_question 澄清具体需求
- 输出文件后必须用文字描述数据结果（不能只输出文件路径）

**禁止**：
- ❌ 不要在未读取数据的情况下编写处理脚本
- ❌ 不要忽略空值处理（NaN/None 必须显式处理）
- ❌ 不要假设日期格式，必须从数据中推断

**数据清洗检查清单**（当任务涉及"清洗/整理/去重"时）：
1. 读取全量数据，检查行数和列名
2. 检测重复：逐列分析哪些列应参与去重判断（不能只用默认 drop_duplicates）
3. 去重后打印行数差异，验证去重数量合理（如"200→188，删除12行"）
4. 缺失值处理：按列类型选择策略（数值→中位数，文本→'未知'，日期→推断）
5. 格式标准化：日期统一 YYYY-MM-DD，货币统一数值，电话号码统一格式
6. 异常值检查：数值列检查极端值（负数、超大值）
7. 输出前做最终验证：行数、列数、空值计数

**模糊指令处理**（当指令含"整理/看看/检查"等模糊词时）：
不要直接开始修改，先做系统诊断：
1. 读取全量数据
2. 逐列分析数据质量：重复值数量、空值数量、异常值、格式不一致
3. 输出诊断报告（哪些列有问题、每种问题的数量）
4. 基于诊断结果，一次性编写清洗脚本处理所有发现的问题
5. 输出清洗前后的对比（行数变化、每种修复的数量）
</system-reminder>
`,

  DOCUMENT_GENERATION: `
<system-reminder>
**文档生成任务**：检测到文档/报告撰写需求。

**工作流程**：
1. 如有参考素材 → 先用 read_file/read_pdf 读取
2. 如需最新数据 → 用 web_search 搜索
3. 按需求结构化撰写（标题层级、段落、列表）
4. 用 write_file 输出为目标格式

**关键规范**：
- 文档必须有清晰的标题层级结构（# / ## / ###）
- 内容必须具体，不留占位符（[TODO]、[待填写]、lorem ipsum）
- 数据/案例必须真实或标注为示例
- 长文档按章节分段，每段聚焦一个主题

**禁止**：
- ❌ 不要生成空洞的模板式内容
- ❌ 不要留下任何未填写的占位符
</system-reminder>
`,

  IMAGE_GENERATION: `
<system-reminder>
**图像生成任务**：检测到图像生成需求。

**工作流程**：
1. 确定图像类型：流程图/架构图 → mermaid_export；照片/插图 → image_generate
2. 生成图像文件（PNG/SVG）
3. 验证文件存在且非空

**工具选择**：
- 流程图/时序图/类图 → mermaid_export（生成 PNG，加 ?type=png）
- 照片/插图/创意图 → image_generate
- 数据图表 → Python matplotlib/seaborn（通过 bash 执行）
- 简单 SVG → 直接 write_file 写 SVG 代码

**禁止**：
- ❌ 不要把 Mermaid 语法直接输出为文本（必须转 PNG）
- ❌ 不要生成空文件或损坏的图片
</system-reminder>
`,

  VIDEO_GENERATION: `
<system-reminder>
**视频生成任务**：检测到视频生成需求。

**工作流程**：
1. 理解用户的视频描述需求（主题、风格、时长）
2. 调用 video_generate 工具生成视频
3. 等待生成完成（异步任务，最长约 5 分钟）
4. 告知用户生成结果和文件位置

**video_generate 参数**：
- prompt: 视频描述（中英文均可，越详细越好）
- aspect_ratio: 16:9（横屏）/ 9:16（竖屏）/ 1:1（方形）/ 4:3 / 3:4
- duration: 5 或 10 秒
- fps: 30 或 60
- quality: "quality"（高质量）或 "speed"（快速）
- image_url: 可选起始图片 URL（图生视频模式）

**提示词优化**：
- 描述场景、运镜、光照、色调，如"航拍城市天际线，金色日落，镜头缓慢右移"
- 工具会自动用 GLM-4-Flash 扩展提示词，但用户描述越具体效果越好

**禁止**：
- ❌ 不要用 bash 调用 ffmpeg 生成视频（应使用 video_generate AI 生成）
- ❌ 不要在视频生成完成前就告诉用户"已完成"
</system-reminder>
`,

  CODE_REVIEW_DIAGNOSIS: `
<system-reminder>
**代码审查诊断模式**：检测到模糊的代码检查指令。

**诊断先行流程**（不要直接修改，先分析）：
1. 读取全部相关代码文件
2. 分类检查：
   - 语法错误 / 类型错误
   - 逻辑错误（边界条件、空值、竞态）
   - 安全漏洞（注入、XSS、硬编码密钥）
   - 性能问题（N+1 查询、内存泄漏、不必要的重渲染）
   - 代码风格（命名、重复代码、过深嵌套）
3. 输出问题清单（按严重程度：🔴 严重 → 🟡 警告 → 🔵 建议 排序）
4. 每个问题标注文件路径:行号 + 修复建议
5. 如果用户要求修复，一次性修复所有问题
</system-reminder>
`,

  SYSTEM_TROUBLESHOOTING: `
<system-reminder>
**系统排查诊断模式**：检测到故障排查指令。

**诊断先行流程**（不要直接猜测修改，先收集证据）：
1. 收集症状信息：
   - 错误日志（用 bash 查看相关日志文件）
   - 状态码和错误消息
   - 问题发生的时间线和频率
2. 列出可能原因（按概率从高到低排序）
3. 逐一验证假设（用工具检查，而非猜测）
4. 输出根因分析报告：
   - 确认的根因
   - 排除的假设及理由
   - 影响范围
5. 提供修复方案（附具体操作步骤）
</system-reminder>
`,
};

/**
 * 任务特征检测结果
 */
export interface TaskFeatures {
  isMultiDimension: boolean;
  isComplexTask: boolean;
  isAuditTask: boolean;
  isReviewTask: boolean;
  isPlanningTask: boolean;
  isPPTTask: boolean;
  isDataTask: boolean;
  isDocumentTask: boolean;
  isImageTask: boolean;
  isVideoTask: boolean;
  isFuzzyCodeReview: boolean;
  isFuzzyTroubleshooting: boolean;
  dimensions: string[];
}

/**
 * 从文本中提取文件扩展名（匹配 .xxx 格式的路径片段）
 */
function extractFileExtensions(text: string): string[] {
  const extPattern = /\.(xlsx|xls|csv|tsv|parquet|json|pdf|docx|doc|pptx|ppt|png|jpg|jpeg|svg|gif|mp4|avi|mov|mkv|webm|md|txt|py|ts|js)\b/gi;
  const exts = new Set<string>();
  let match;
  while ((match = extPattern.exec(text)) !== null) {
    exts.add('.' + match[1].toLowerCase());
  }
  return Array.from(exts);
}

/** 按类型分组的文件扩展名 */
const DATA_FILE_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.tsv', '.parquet'];
const PPT_FILE_EXTENSIONS = ['.pptx', '.ppt'];
const DOC_FILE_EXTENSIONS = ['.docx', '.doc', '.pdf'];
const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.gif'];
const VIDEO_FILE_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv', '.webm'];

/**
 * 检测任务特征
 * @param fileExtensions 调用方传入的附件文件扩展名（可选，用于 Electron 附件场景）
 */
export function detectTaskFeatures(prompt: string, fileExtensions?: string[]): TaskFeatures {
  const normalizedPrompt = prompt.toLowerCase();

  // 合并：调用方传入的扩展名 + 从 prompt 文本提取的扩展名
  const allExtensions = [
    ...(fileExtensions || []).map(e => e.toLowerCase()),
    ...extractFileExtensions(prompt),
  ];
  const hasDataFile = allExtensions.some(ext => DATA_FILE_EXTENSIONS.includes(ext));
  const hasPPTFile = allExtensions.some(ext => PPT_FILE_EXTENSIONS.includes(ext));
  const hasDocFile = allExtensions.some(ext => DOC_FILE_EXTENSIONS.includes(ext));
  const hasImageFile = allExtensions.some(ext => IMAGE_FILE_EXTENSIONS.includes(ext));
  const hasVideoFile = allExtensions.some(ext => VIDEO_FILE_EXTENSIONS.includes(ext));

  // 维度关键词
  const dimensionKeywords = [
    '安全', '性能', '质量', '审计', '分析',
    '认证', '授权', '输入验证', '数据安全', '依赖',
    '前端', '后端', '数据库', 'api', '配置',
  ];

  // 检测匹配的维度
  const matchedDimensions = dimensionKeywords.filter((d) =>
    normalizedPrompt.includes(d)
  );

  // 复杂任务关键词
  const complexKeywords = [
    '全面', '完整', '整个项目', '所有', '彻底',
    '详细分析', '深入', '系统性',
  ];

  // 审计任务关键词
  const auditKeywords = ['审计', '安全检查', '漏洞扫描', '安全分析'];

  // 审查任务关键词
  const reviewKeywords = ['审查', 'review', '代码检查', 'code review'];

  // 规划任务关键词
  const planningKeywords = ['设计', '实现', '规划', '方案', '架构'];

  // PPT 任务关键词
  const pptKeywords = [
    'ppt', 'powerpoint', 'slidev', '演示文稿', '幻灯片',
    '演示', 'presentation', 'slide', '做个ppt', '生成ppt',
    '制作ppt', '写个ppt', 'slides',
  ];

  // 数据处理任务关键词
  const dataKeywords = [
    'excel', 'xlsx', 'csv', '数据', '分析', '清洗',
    '透视', '聚合', '统计', 'dataframe', 'pandas',
    '表格处理', '数据处理',
  ];

  // 文档生成任务关键词
  const documentKeywords = [
    '文章', '报告', '文档', '撰写', '写一篇',
    'report', 'article', 'document',
    '起草', '草拟', '编写文档',
  ];

  // 图像生成任务关键词
  const imageKeywords = [
    '生成图', '画图', '画一个', '画一张',
    'image', 'draw', 'generate image',
    '生图', '插图', '制图', '作图',
    '流程图', '架构图', '示意图', '思维导图',
  ];

  // 视频生成任务关键词
  const videoKeywords = [
    '生成视频', '做个视频', '制作视频', '视频生成',
    'video', 'generate video', '短视频',
    '动画', '视频片段',
  ];

  // 模糊指令词（用于行为引导，不用于路由）
  const fuzzyWords = ['看看', '检查', '有啥问题', '有什么问题', '排查', '整理'];
  const hasFuzzyIntent = fuzzyWords.some(w => normalizedPrompt.includes(w));

  // 代码审查模糊指令：含模糊词 + 代码相关上下文
  const codeContextWords = ['代码', '代码库', '函数', '组件', '模块', 'code', '实现', '逻辑'];
  const hasCodeContext = codeContextWords.some(w => normalizedPrompt.includes(w));

  // 系统排查模糊指令：含模糊词 + 系统/故障上下文
  const troubleContextWords = [
    '服务器', '接口', '报错', '故障', '异常', '崩溃', '超时',
    '不工作', '挂了', '出错', 'error', 'bug', '日志',
  ];
  const hasTroubleContext = troubleContextWords.some(w => normalizedPrompt.includes(w));

  return {
    isMultiDimension: matchedDimensions.length >= 2,
    isComplexTask: complexKeywords.some((k) => normalizedPrompt.includes(k)),
    isAuditTask: auditKeywords.some((k) => normalizedPrompt.includes(k)),
    isReviewTask: reviewKeywords.some((k) => normalizedPrompt.includes(k)),
    isPlanningTask: planningKeywords.some((k) => normalizedPrompt.includes(k)),
    isPPTTask: hasPPTFile || pptKeywords.some((k) => normalizedPrompt.includes(k)),
    isDataTask: hasDataFile || dataKeywords.some((k) => normalizedPrompt.includes(k)),
    isDocumentTask: hasDocFile || documentKeywords.some((k) => normalizedPrompt.includes(k)),
    isImageTask: hasImageFile || imageKeywords.some((k) => normalizedPrompt.includes(k)),
    isVideoTask: hasVideoFile || videoKeywords.some((k) => normalizedPrompt.includes(k)),
    isFuzzyCodeReview: hasFuzzyIntent && hasCodeContext,
    isFuzzyTroubleshooting: hasFuzzyIntent && hasTroubleContext,
    dimensions: matchedDimensions,
  };
}

/**
 * 根据任务特征获取需要注入的系统提醒
 */
export function getSystemReminders(prompt: string, fileExtensions?: string[]): string[] {
  const features = detectTaskFeatures(prompt, fileExtensions);
  const reminders: string[] = [];

  // 内容生成任务（互斥，按优先级排列）
  if (features.isPPTTask) {
    reminders.push(REMINDERS.PPT_FORMAT_SELECTION);
  } else if (features.isDataTask) {
    reminders.push(REMINDERS.DATA_PROCESSING);
  } else if (features.isVideoTask) {
    reminders.push(REMINDERS.VIDEO_GENERATION);
  } else if (features.isDocumentTask) {
    reminders.push(REMINDERS.DOCUMENT_GENERATION);
  } else if (features.isImageTask) {
    reminders.push(REMINDERS.IMAGE_GENERATION);
  }

  // 多维度任务 → 并行派发提醒
  if (features.isMultiDimension) {
    reminders.push(REMINDERS.PARALLEL_DISPATCH);
  }

  // 复杂任务 → 必须委派提醒
  if (features.isComplexTask && !features.isMultiDimension) {
    reminders.push(REMINDERS.MUST_DELEGATE);
  }

  // 审计任务 → 审计模式提醒
  if (features.isAuditTask) {
    reminders.push(REMINDERS.AUDIT_MODE);
  }

  // 审查任务 → 审查模式提醒
  if (features.isReviewTask && !features.isAuditTask) {
    reminders.push(REMINDERS.REVIEW_MODE);
  }

  // 模糊指令诊断提示（与内容生成任务不互斥，可叠加）
  if (features.isFuzzyCodeReview) {
    reminders.push(REMINDERS.CODE_REVIEW_DIAGNOSIS);
  }
  if (features.isFuzzyTroubleshooting) {
    reminders.push(REMINDERS.SYSTEM_TROUBLESHOOTING);
  }

  return reminders;
}

/**
 * 将系统提醒附加到用户消息
 */
export function appendRemindersToMessage(
  userMessage: string,
  reminders: string[]
): string {
  if (reminders.length === 0) {
    return userMessage;
  }

  return userMessage + '\n\n' + reminders.join('\n');
}
