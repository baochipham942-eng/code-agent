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
  | 'SYSTEM_TROUBLESHOOTING'
  | 'SCREEN_CAPTURE';

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

你应该使用 AgentSpawn 的 parallel 模式，或用 workflow 编排 fan-out/fan-in，而不是逐个执行：

\`\`\`
{
  "parallel": true,
  "agents": [
    { "role": "reviewer", "task": "维度1: ..." },
    { "role": "explore", "task": "维度2: ..." },
    { "role": "reviewer", "task": "维度3: ..." }
  ]
}
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

可以使用 Task 工具委派给单个同步子代理；需要并行、后台、自定义工具或预算控制时用 AgentSpawn。

如果目标文件、函数、编辑区域已经明确，直接使用 Read/Grep/Edit 完成。
需要委派时使用真实工具名：
- 安全审计 → Task，参数 {"subagent_type": "reviewer", "prompt": "..."}
- 代码探索 → Task，参数 {"subagent_type": "explore", "prompt": "..."}
- 架构分析 → Task，参数 {"subagent_type": "plan", "prompt": "..."}
</system-reminder>
`,

  /**
   * 规划模式激活提醒
   */
  PLAN_MODE_ACTIVE: `
<system-reminder>
**Plan Mode 已激活**：你现在处于只读规划模式。

5-Phase 流程：
1. Phase 1: 用 Task(explore) 做单点探索；多路独立探索用 AgentSpawn
2. Phase 2: 派发 plan 子代理设计方案
3. Phase 3: 整合结果，使用 AskUserQuestion 澄清
4. Phase 4: 生成最终计划
5. Phase 5: 调用 PlanMode exit（必须用工具调用）

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
1. 使用 AgentSpawn 并行派发多个 reviewer 子代理，每个负责一个维度
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
2. 需要多维度并行时，用 AgentSpawn 派发 reviewer 子代理分析不同方面
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

**默认路径**：优先使用 \`frontend-slides\` skill（或 \`/ppt\` 兼容入口），不要默认调用 legacy \`ppt_generate\`

**输出格式**：优先产出 slide deck 目录 + PPTX/PDF 文件（可用 PowerPoint/WPS/Keynote 打开编辑）

**工作流程**：
1. 如有本地文档素材 → 使用 ReadDocument/Read 读取
2. 调用 \`skill({ "command": "frontend-slides", "args": "..." })\` 或处理 \`/ppt\`
3. 先生成 \`outline.md\` 与逐页 prompts
4. 如需图表/配图 → 生成逐页图片
5. 合成为 PPTX / PDF
6. 验证 \`outline.md\`、\`slides.json\`、图片数量和 PPTX/PDF 文件存在；能读取结构时要回读 PPTX 结构

**frontend-slides 调用示例**：
\`\`\`
skill({
  command: "frontend-slides",
  args: "Agent Neo 产品介绍，10 页，商务汇报风格"
})
\`\`\`

**风格选择**：
- 技术分享 → \`blueprint\` / \`editorial-infographic\`
- 产品介绍 → \`bold-editorial\`
- 企业汇报 → \`corporate\`
- 高管简报 → \`minimal\`

**禁止**：
- ❌ 不要默认调用 \`ppt_generate\`
- ❌ 不要跳过 \`outline.md\` / \`prompts/\` 直接粗糙出图
- ❌ 不要把 Mermaid 代码直接塞给图片生成模型
- ❌ 不要把 Marvis 的 PC 应用宝 / 小程序流程接进 Mac runtime；这类信息只作参考资料
</system-reminder>
`,

  DATA_PROCESSING: `
<system-reminder>
**数据处理任务**：检测到数据分析/处理需求。

**工作流程**：
1. 先用 ReadDocument/Read 读取源数据，了解结构（列名、数据类型、行数）
2. 先分析，再决定是否生成或编辑文件；只读查看、定位、摘要不要直接进入 Excel skill
3. 分析需求，确定处理逻辑（筛选/聚合/透视/时序分析等）
4. 用 Bash 执行 Python/pandas 脚本处理数据
5. 输出结果到指定格式（xlsx/csv），并描述关键发现
6. 生成或编辑 xlsx 后必须回读结构，验证 sheet、行数、关键列、公式和图表相关输出

**⚠️ 脚本合并原则（强制）**：
- 读取数据结构后，将所有分析、计算、可视化、输出合并到 **1-2 个完整 Python 脚本** 中执行
- 禁止每个分析指标/图表单独一轮 bash 调用——这会快速耗尽迭代次数导致任务中断
- 正确做法：一个脚本内完成 读取 → 清洗 → 多维分析 → 生成图表 → 保存结果
- 仅当脚本报错需要调试时才允许额外的 bash 调用

**关键规范**：
- 先读数据再写代码，不要猜测列名和数据格式
- 时序分析必须正确设置日期索引（pd.to_datetime + set_index）
- 聚合统计结果要验证：行数、空列、数值合理性
- 模糊指令（如"分析一下"）→ 先用 AskUserQuestion 澄清具体需求
- 输出文件后必须用文字描述数据结果（不能只输出文件路径）
- matplotlib 图表含中文文字时，设置字体：plt.rcParams['font.sans-serif'] = ['PingFang SC', 'SimHei', 'STHeiti']；plt.rcParams['axes.unicode_minus'] = False

**禁止**：
- ❌ 不要在未读取数据的情况下编写处理脚本
- ❌ 不要先生成 Excel 再补分析；Excel 任务必须先分析数据结构和计算口径
- ❌ 不要忽略空值处理（NaN/None 必须显式处理）
- ❌ 不要假设日期格式，必须从数据中推断
- ❌ 禁止用 excel_generate 内联数据生成 Excel —— 必须用 bash + Python（pandas/openpyxl）从源文件读取数据、计算、写出。内联数据会丢失精度导致数据伪造
- ❌ 禁止凭记忆编造数据 —— 所有数值必须来自 pd.read_excel() 读取的源文件，不得手写数据行

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
1. 如有参考素材 → 先用 Read/ReadDocument 读取
2. 文件查找、文本搜索、轻量摘要优先用 Glob/Grep/Read；宽泛文本检索可用 Bash 调 \`rg\`
3. 如需最新数据 → 用 WebSearch 搜索
4. 按需求结构化撰写（标题层级、段落、列表）
5. 需要 DOCX 编辑/生成、修订、复杂排版或多文件合并时，进入 \`docx\` skill
6. 用 Write 输出 Markdown/文本；生成 DOCX 后必须回读结构和关键文本

**关键规范**：
- 文档必须有清晰的标题层级结构（# / ## / ###）
- 内容必须具体，不留占位符（[TODO]、[待填写]、lorem ipsum）
- 数据/案例必须真实或标注为示例
- 长文档按章节分段，每段聚焦一个主题
- 生成 Office 文件后必须做回读或结构校验，不只报路径

**禁止**：
- ❌ 不要因为出现 docx/pdf/pptx/xlsx 扩展名就直接进入生成工具；先判断用户是读/搜/摘要还是编辑/生成
- ❌ 不要生成空洞的模板式内容
- ❌ 不要留下任何未填写的占位符
- ❌ 不要把 Marvis 的 PC 应用宝 / 小程序流程接进 Mac runtime；这类信息只作参考资料
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
- 简单 SVG → 直接 Write 写 SVG 代码

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

  SCREEN_CAPTURE: `
<system-reminder>
**截屏分析模式**：检测到截屏/查看屏幕请求。走最短路径，不要先 ToolSearch 找截屏工具：

1. 截屏：直接用 Bash 运行 \`screencapture -x /tmp/screen.png\`（macOS 原生命令，无需加载额外工具）
2. 分析：image_analyze 已预加载，直接传图片路径 + 分析要求，结果会完整返回，一次调用即可
3. 拿到分析结果后直接总结回答，不要重复调用 image_analyze 或用其他方式（Python/sips）二次验证
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
  isExcelTask: boolean;
  isDocumentTask: boolean;
  isImageTask: boolean;
  isVideoTask: boolean;
  isFuzzyCodeReview: boolean;
  isFuzzyTroubleshooting: boolean;
  /** 截屏/查看当前屏幕意图（区别于分析已有截图文件） */
  isScreenCaptureTask: boolean;
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

/**
 * 关键词匹配：ASCII 关键词走词边界，中文走子串
 *
 * 中文没有词边界，只能子串匹配；但 ASCII 词裸子串匹配会咬到代码标识符——
 * `sheet` ⊂ stylesheet、`slide` ⊂ slider、`draw` ⊂ drawer、`poster` ⊂ posterUrl。
 * JS 的 \b 基于 \w=[A-Za-z0-9_]，中文字符不是 \w，所以「这是excel文件」里的 excel
 * 两侧都成立边界，中英混排照常命中。
 *
 * ⚠️ 词边界救不了独立 token：`document.getElementById` 里的 document 两侧都是边界，
 * 照样命中。那类只能靠不收裸词（见下方 WEAK/STRONG 分级）。
 */
function matchesKeyword(normalizedText: string, keyword: string): boolean {
  if (!/^[\x20-\x7e]+$/.test(keyword)) return normalizedText.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(normalizedText);
}

const hasAnyKeyword = (normalizedText: string, keywords: string[]): boolean =>
  keywords.some((k) => matchesKeyword(normalizedText, k));

/**
 * 代码语境词——弱产物信号遇到它们要让位
 *
 * 刻意**不含** `函数`/`实现`/`逻辑`/`code`：
 * - `函数`：Excel 也有函数，「Excel 里这个函数怎么写」是真表格诉求
 * - `实现`：可以「实现方案」，不专属代码
 * - `逻辑`：有「业务逻辑」
 * 这几个词在 codeContextWords（isFuzzyCodeReview 用）里是合理的，但拿来否决产物意图太钝。
 */
const CODE_ARTIFACT_CONTEXT = [
  '代码', '代码库', '重构', '报错', '编译', '调用栈',
  'bug', '组件', '模块', '接口',
];

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

  // 附件扩展名是强证据；正文里的扩展名还要结合产物意图判断。
  const attachmentExtensions = (fileExtensions || []).map(e => e.toLowerCase());
  const promptExtensions = extractFileExtensions(prompt);
  const allExtensions = [
    ...attachmentExtensions,
    ...promptExtensions,
  ];
  const hasDataFile = allExtensions.some(ext => DATA_FILE_EXTENSIONS.includes(ext));
  const hasPPTFile = allExtensions.some(ext => PPT_FILE_EXTENSIONS.includes(ext));
  const hasDocAttachment = attachmentExtensions.some(ext => DOC_FILE_EXTENSIONS.includes(ext));
  const hasDocPromptReference = promptExtensions.some(ext => DOC_FILE_EXTENSIONS.includes(ext));
  const hasImageAttachment = attachmentExtensions.some(ext => IMAGE_FILE_EXTENSIONS.includes(ext));
  const hasImagePromptReference = promptExtensions.some(ext => IMAGE_FILE_EXTENSIONS.includes(ext));
  const hasVideoFile = allExtensions.some(ext => VIDEO_FILE_EXTENSIONS.includes(ext));

  // 维度关键词
  const dimensionKeywords = [
    '安全', '性能', '质量', '审计', '分析',
    '认证', '授权', '输入验证', '数据安全', '依赖',
    '前端', '后端', '数据库', 'api', '配置',
    'security', 'performance', 'quality', 'auth',
    'frontend', 'backend', 'database',
  ];

  // 检测匹配的维度
  const matchedDimensions = dimensionKeywords.filter((d) =>
    normalizedPrompt.includes(d)
  );

  // 复杂任务关键词
  const complexKeywords = [
    '全面', '完整', '整个项目', '所有', '彻底',
    '详细分析', '深入', '系统性',
    'comprehensive', 'thorough', 'entire project', 'entire codebase',
    'full audit', 'in-depth', 'systematic', 'end-to-end',
  ];

  // 审计任务关键词
  const auditKeywords = ['审计', '安全检查', '漏洞扫描', '安全分析', 'security audit', 'vulnerability scan'];

  // 审查任务关键词
  const reviewKeywords = ['审查', 'review', '代码检查', 'code review'];

  // 规划任务关键词
  const planningKeywords = ['设计', '实现', '规划', '方案', '架构', 'design', 'implement', 'architect', 'roadmap'];

  // PPT 任务关键词
  //
  // 刻意只收不与代码语境碰撞的词。裸词 '演示' / 'slide' / 'slides' / 'presentation'
  // 已移除——它们是子串匹配，实测把「演示一下这个 API 怎么调用」「改一下 slider 组件」
  // 「presentation 层的接口」全判成 PPT 任务（6/11 误判），既污染 few-shot 示例选择，
  // 也让这些 prompt 白吃一份 250 token 的 PPT 提醒。
  // 英文侧改用无歧义的多词短语（'a presentation' / 'some slides' / 'slide deck'），
  // 既保住「make a presentation about X」，又不会被「presentation 层」「carousel
  // slides」咬到。
  const pptKeywords = [
    'ppt', 'pptx', 'powerpoint', 'slidev', '演示文稿', '演示稿', '幻灯片',
    'slide deck', 'a presentation', 'some slides', 'make slides',
    '做个ppt', '生成ppt', '制作ppt', '写个ppt',
  ];

  // 数据处理任务关键词
  const dataKeywords = [
    'excel', 'xlsx', 'csv', '数据', '分析', '清洗',
    '透视', '聚合', '统计', 'dataframe', 'pandas',
    '表格处理', '数据处理',
  ];

  // --------------------------------------------------------------------------
  // 产物关键词：强信号 / 弱信号分级
  //
  // 强 = 无歧义的产物名词，代码语境也不否决（「介绍代码库的 PPT」交付物仍是 PPT）
  // 弱 = 与代码语境重叠的词，命中 CODE_ARTIFACT_CONTEXT 时让位
  //
  // 裸英文词（image / document / video / draw / report / article）一律不收：它们买不到
  // 什么（中文用户说「配图」「文档」，英文用户说 "an image" / "write a document" 都是短语），
  // 却会咬到 document.getElementById、image 上传、report 接口、draw 方法。词边界救不了
  // 这类独立 token，只能不收。
  // --------------------------------------------------------------------------

  // Excel 专属关键词（isDataTask 的子集，用于触发 Excel 场景化提醒）
  // '函数' 不收：它同时是代码词，「这个函数写错了」会被判成表格任务；
  // Excel 的函数诉求走 'excel' 弱信号（「excel 里这个函数怎么写」照样命中）。
  const excelStrongKeywords = [
    '透视表', '数据透视', '单元格', '工作表', 'vlookup', 'vba', 'openpyxl', 'xlwings',
  ];
  const excelWeakKeywords = [
    'excel', 'xlsx', 'xls', 'sheet', '公式', '数据清洗', '去重', '汇总',
  ];

  // 文档生成任务关键词
  const documentStrongKeywords = [
    '文章', '撰写', '写一篇', '起草', '草拟', '编写文档',
    'write a document', 'write a report',
  ];
  const documentWeakKeywords = ['报告', '文档'];

  // 图像生成任务关键词（全强：都是无歧义的产物名词/动作）
  const imageStrongKeywords = [
    '生成图', '画图', '画一个', '画一张',
    '生图', '插图', '制图', '作图', '配图', '海报',
    '流程图', '架构图', '示意图', '思维导图',
    'generate image', 'an image', 'draw a',
  ];

  // 视频生成任务关键词（全强）
  // 裸 '动画' 不收：区分「做个动画」（视频）和「给 drawer 加动画」（CSS）靠的是动词不是
  // 强弱，所以只收带动词的短语形式。
  const videoStrongKeywords = [
    '生成视频', '做个视频', '制作视频', '视频生成', '短视频', '视频片段',
    '做个动画', '生成动画', '制作动画', '动画视频', '一段动画',
    'generate video', 'a video',
  ];

  // 截屏/查看当前屏幕关键词（刻意不含裸"截图"——"分析这张截图"是分析已有文件，
  // 不是要去截屏；预载 image_analyze + 截屏 reminder 只对"现在去截"的意图生效）
  const screenCaptureKeywords = [
    '截屏', '截个屏', '屏幕截图', '截取屏幕', '截图屏幕',
    '看看屏幕', '看下屏幕', '看一下屏幕', '当前屏幕', '屏幕上有',
    'screenshot', 'screen capture', 'capture the screen', 'capture screen',
    'on my screen',
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

  // 弱产物信号的否决门。附件是最强证据（真有 .xlsx 附件就是表格任务），不受它影响。
  const hasCodeArtifactContext = hasAnyKeyword(normalizedPrompt, CODE_ARTIFACT_CONTEXT);
  const weakHit = (keywords: string[]) =>
    !hasCodeArtifactContext && hasAnyKeyword(normalizedPrompt, keywords);

  return {
    isMultiDimension: matchedDimensions.length >= 2,
    isComplexTask: complexKeywords.some((k) => normalizedPrompt.includes(k)),
    isAuditTask: auditKeywords.some((k) => normalizedPrompt.includes(k)),
    isReviewTask: reviewKeywords.some((k) => normalizedPrompt.includes(k)),
    isPlanningTask: planningKeywords.some((k) => normalizedPrompt.includes(k)),
    isPPTTask: hasPPTFile || hasAnyKeyword(normalizedPrompt, pptKeywords),
    isDataTask: hasDataFile || dataKeywords.some((k) => normalizedPrompt.includes(k)),
    isExcelTask: (hasDataFile && allExtensions.some(ext => ['.xlsx', '.xls'].includes(ext))) ||
                 hasAnyKeyword(normalizedPrompt, excelStrongKeywords) ||
                 weakHit(excelWeakKeywords),
    isDocumentTask: hasDocAttachment ||
                    (!hasCodeArtifactContext && hasDocPromptReference) ||
                    hasAnyKeyword(normalizedPrompt, documentStrongKeywords) ||
                    weakHit(documentWeakKeywords),
    isImageTask: hasImageAttachment ||
                 (!hasCodeArtifactContext && hasImagePromptReference) ||
                 hasAnyKeyword(normalizedPrompt, imageStrongKeywords),
    isVideoTask: hasVideoFile || hasAnyKeyword(normalizedPrompt, videoStrongKeywords),
    isFuzzyCodeReview: hasFuzzyIntent && hasCodeContext,
    isFuzzyTroubleshooting: hasFuzzyIntent && hasTroubleContext,
    isScreenCaptureTask: screenCaptureKeywords.some((k) => normalizedPrompt.includes(k)),
    dimensions: matchedDimensions,
  };
}

/**
 * 根据任务特征获取需要注入的系统提醒
 */
export function getSystemReminders(prompt: string, fileExtensions?: string[]): string[] {
  const features = detectTaskFeatures(prompt, fileExtensions);
  const reminders: string[] = [];

  // 截屏分析意图优先于内容生成链："分析下屏幕上有什么"含"分析"会误中
  // isDataTask，但它不是数据处理任务
  if (features.isScreenCaptureTask) {
    reminders.push(REMINDERS.SCREEN_CAPTURE);
  } else if (features.isPPTTask) {
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
