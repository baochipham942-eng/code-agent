// ============================================================================
// Built-in Skills - 内置 Skill 定义
// ============================================================================

import type { ParsedSkill } from '../../../shared/types/agentSkill';

/**
 * 内置 Skill 定义列表
 * 这些 Skill 会自动加载，用户无需额外配置
 */
export const BUILTIN_SKILLS: ParsedSkill[] = [
  {
    name: 'commit',
    description: '创建 Git commit，自动生成 commit message',
    promptContent: `请帮我创建一个 Git commit。

1. 首先运行 git status 查看当前状态
2. 如果有未暂存的更改，询问用户是否需要先暂存
3. 分析已暂存的更改内容
4. 生成一个符合 Conventional Commits 规范的 commit message
5. 执行 git commit

Commit message 格式：
- feat: 新功能
- fix: Bug 修复
- docs: 文档更新
- style: 代码格式（不影响代码运行的变动）
- refactor: 重构
- test: 测试相关
- chore: 其他修改

请确保 commit message 简洁明了，概括此次更改的主要内容。`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    bins: ['git'],
  },
  {
    name: 'review',
    description: '代码审查，检查代码质量和潜在问题',
    promptContent: `请对指定的代码进行审查。

审查要点：
1. **代码质量**：变量命名、函数长度、代码复杂度
2. **潜在 Bug**：空指针、边界条件、异常处理
3. **安全性**：输入验证、SQL 注入、XSS
4. **性能**：循环优化、缓存使用、内存泄漏
5. **可维护性**：注释、模块化、测试覆盖

输出格式：
- 问题严重程度：🔴 严重 / 🟡 警告 / 🟢 建议
- 问题位置：文件名:行号
- 问题描述和修复建议

请逐个文件进行审查，最后给出总体评价。`,
    basePath: '',
    allowedTools: ['read_file', 'glob', 'grep'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'test',
    description: '运行测试并分析结果',
    promptContent: `请运行项目测试并分析结果。

步骤：
1. 检测项目类型（查看 package.json、setup.py、Cargo.toml 等）
2. 运行相应的测试命令
3. 分析测试输出
4. 如果有失败的测试，分析原因并给出修复建议

常见测试命令：
- Node.js: npm test / npm run test / yarn test
- Python: pytest / python -m pytest
- Rust: cargo test
- Go: go test ./...

输出包括：
- 测试总数
- 通过数/失败数
- 失败测试的详细信息
- 建议的修复方案`,
    basePath: '',
    allowedTools: ['bash', 'read_file'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'explain',
    description: '解释代码功能和工作原理',
    promptContent: `请解释指定代码的功能和工作原理。

解释应包括：
1. **总体功能**：这段代码的主要目的
2. **核心逻辑**：关键算法或数据流程
3. **依赖关系**：使用的外部库或模块
4. **输入输出**：函数参数和返回值
5. **注意事项**：潜在的陷阱或使用限制

请用通俗易懂的语言，适合初学者理解。如果代码较复杂，可以分步骤解释。`,
    basePath: '',
    allowedTools: ['read_file', 'grep', 'glob'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'refactor',
    description: '重构代码，提高可读性和可维护性',
    promptContent: `请对指定代码进行重构。

重构原则：
1. **保持功能不变**：重构不应改变代码行为
2. **提高可读性**：改善命名、简化逻辑
3. **减少重复**：提取公共函数、使用设计模式
4. **增强可维护性**：模块化、解耦合

重构步骤：
1. 先理解现有代码的功能
2. 识别代码异味（Code Smells）
3. 逐步进行小幅重构
4. 每次重构后确保测试通过

请在修改前说明重构意图，在修改后解释改进点。`,
    basePath: '',
    allowedTools: ['read_file', 'edit_file', 'write_file', 'bash'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'docker',
    description: '管理 Docker 容器和镜像',
    promptContent: `帮助管理 Docker 容器和镜像。

可执行的操作：
1. **查看状态**：列出容器、镜像、网络
2. **容器管理**：启动、停止、重启、删除容器
3. **镜像管理**：拉取、构建、删除镜像
4. **日志查看**：查看容器日志
5. **调试**：进入容器 shell、检查配置

注意事项：
- 执行删除操作前会先确认
- 不会执行 docker system prune 等危险命令
- 会显示命令执行结果`,
    basePath: '',
    allowedTools: ['bash', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    bins: ['docker'],
  },
  {
    name: 'ppt',
    description: '智能 PPT 生成（SCQA 框架、自动判断联网搜索、控制图表数量）',
    promptContent: `# PPT 生成专家

你是专业的演示文稿专家。输出 .pptx 文件，用户可直接用 PowerPoint/WPS/Keynote 编辑。

**🚨 关键原则：先收集信息，再生成 PPT！内容必须来自实际搜索/读取结果！**

---

## Step 1: 判断信息来源（必做）

### 场景 A：本地项目（如工作目录下的项目）
**必须先读取项目文件获取真实信息：**
1. \`read_file("CLAUDE.md")\` - 项目概述
2. \`read_file("README.md")\` - 功能介绍
3. \`read_file("docs/ARCHITECTURE.md")\` - 架构设计
4. \`read_file("package.json")\` - 技术栈

### 场景 B：公共产品/技术
**必须执行 3 次 web_search：**
1. "{topic} 核心功能 特性 官方文档 2026"
2. "{topic} 技术架构 原理 实现细节"
3. "{topic} 用户评价 案例 使用数据"

### 场景 C：用户已提供完整内容
直接使用用户提供的内容。

**❌ 禁止凭空捏造内容！必须基于搜索/读取的真实数据！**

---

## Step 2: 构建大纲（SCQA 框架）

| 类型 | 内容 | 布局 |
|------|------|------|
| S - Situation | 行业背景、市场现状 | highlight |
| C - Complication | 痛点、挑战 | cards |
| Q - Question | 核心问题（可隐含） | - |
| A - Answer | 解决方案、功能特性 | list / cards |
| E - Evidence | 数据支撑、案例 | stats |

**10 页 PPT 标准结构**：
1. 封面
2. 行业背景（S）
3. 核心价值（A）
4. 行业数据（E）- 可用图表
5. 功能特性（A）
6. 技术架构（A）- 可用图表
7. 工作流程（A）- 可用图表
8. 应用效果（E）
9. 使用场景（A）
10. 总结/谢谢

---

## Step 3: 图表决策

**原生可编辑图表（自动）：**
- 包含数字/百分比的数据内容 → ppt_generate 会自动生成原生可编辑图表
- 用户下载后可在 PowerPoint 中直接编辑图表数据
- 无需手动调用 mermaid_export

**如果需要复杂流程图：**
- 工作流程/架构图 → 可用 mermaid_export 生成透明 PNG，通过 images 参数传入
- 10 页 PPT 最多 1-2 张流程图

---

## Step 4: 生成 PPTX

**默认 10 页，用户要求 5 页时也至少生成 8 页（内容更充实）**

\`\`\`
ppt_generate({
  topic: "标题",
  content: "# 封面\\n## 副标题\\n# 技术架构\\n- 要点1（来自搜索结果）\\n- 要点2（具体数据）",
  theme: "neon-green",
  slides_count: 10
})
\`\`\`

**⚠️ content 中的每个要点必须来自 Step 1 收集的真实信息！**

**主题选项**：
- \`neon-green\`: 霓虹绿（科技感，推荐）
- \`neon-blue\`: 电光蓝（专业感）
- \`neon-purple\`: 霓虹紫（创意感）
- \`apple-dark\`: 苹果发布会极简风格（纯黑背景）
- \`corporate\`: 企业蓝（商务感）

---

## 内容质量要求

❌ 空洞：
- 支持多语言
- 性能优秀

✅ 具体：
- 🌍 **50+ 编程语言**支持
- ⚡ **延迟 < 100ms**，比传统方案快 3 倍

---

## ❌ 禁止事项

1. **禁止每页都放图表** - 10 页最多 3-4 张
2. **禁止内容空洞** - 必须有具体数据和案例
3. **禁止跳过信息收集** - 公共产品要 web_search，本地项目要 read_file
4. **禁止少于 8 页** - 即使用户说 5 页，也要生成 8-10 页以保证内容质量`,
    basePath: '',
    allowedTools: [
      'ask_user_question',
      'read_file',
      'read_pdf',
      'glob',
      'list_directory',
      'web_search',
      'web_fetch',
      'mermaid_export',
      'ppt_generate',
    ],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'data-cleaning',
    description: '系统性数据清洗与分析 — 处理 Excel/CSV 数据时自动使用，覆盖去重、缺失值、异常值修正、格式标准化、分类统计等',
    promptContent: `# Excel/CSV 数据处理规范

## 核心原则

1. **每步验证，不假设成功** — 去重后检查是否还有残留，格式转换后检查覆盖率，异常修正后检查值域。一次处理没干净就再来一次。
2. **交付干净数据，不交付报告** — 你的产出是修正后的数据文件，不是问题分析报告。"发现异常并建议人工复核"等于没做。
3. **需求要图表就必须有图表** — 需求提到占比、分布、趋势等可视化意图时，输出中必须包含对应图表（嵌入 xlsx 或独立 png），不能只给数据表。

## 工作流程: 读取 → 理解 → 逐步处理 → 每步验证 → 输出 → 回读

### 第一步：理解数据（必做，不可跳过）
\`\`\`python
df = pd.read_excel('file.xlsx')
print(df.shape, df.dtypes)
print(df.describe(include='all'))
for col in df.columns:
    print(f"{col}: {df[col].nunique()} unique, {df[col].isna().sum()} null")
    if df[col].dtype == 'object':
        print(f"  → {df[col].value_counts().to_dict()}")
\`\`\`

### 去重
❌ df.drop_duplicates()  # 全列匹配，遗漏业务重复
✅ df.drop_duplicates(subset=['订单号'])  # 指定业务主键
✅ print(f"去重: {before}→{after} 行, 删除 {before-after}")
去重后回查一次主键列的 duplicated 计数，若不为零则排查原因继续清洗

### 缺失值
按列类型选策略：数值→中位数, 文本→'未知'/众数, 日期→推断
✅ df['金额'].fillna(df['金额'].median(), inplace=True)
✅ 填充后确认: df.isna().sum()

### 异常值修正
检测到不合理的值（负数金额、极端离群值等）必须在数据中实际修正，不能只标记或只写进报告。
修正后用 describe() 确认值域恢复合理。

### 格式标准化
- 性别: 先 value_counts() 查全部取值，再统一映射
  ✅ mapping = {'M':'男','male':'男','F':'女','female':'女','f':'女','m':'男'}
  ✅ df['性别'] = df['性别'].map(mapping).fillna(df['性别'])
- 日期: pd.to_datetime → strftime('%Y-%m-%d')，转换后检查覆盖率，未命中的单独处理
- 电话: str处理→去非数字→补齐11位→验证

### 文本分类与情感分析
对于分类任务，逐条分析内容再分类，不要批量猜测：
✅ 根据评分+文本内容综合判断: 评分>=4=好评, <=2=差评, 其余=中评
✅ 分类结果写入新列，再做 groupby 统计
❌ 凭空给所有行贴同一个标签

### 输出验证（必做）
\`\`\`python
result = pd.read_excel('output.xlsx')
print(f"行列: {result.shape}, 缺失值: {result.isna().sum().sum()}")
print(result.head(3))
print(result.describe())
\`\`\`

### 工具选择
- pandas: 数据分析、聚合统计、去重清洗（90%场景）
- openpyxl: 需要公式、格式、多sheet样式、嵌入图表时
- matplotlib: 图表含中文必须设置字体 plt.rcParams['font.sans-serif']=['SimHei']`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'read_xlsx', 'write_file', 'edit_file'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    bins: ['python3'],
  },
  {
    name: 'xlsx',
    description: 'Excel 表格创建、编辑与公式 — 需要生成带公式/格式的 xlsx 文件时自动使用，覆盖财务建模、数字格式、公式构造、recalc 验证等',
    promptContent: `# Excel 文件创建与编辑规范（对标 Anthropic xlsx skill）

## 核心原则：使用公式，不硬编码计算值

❌ 错误 — Python 计算后硬编码:
\`\`\`python
total = df['Sales'].sum()
sheet['B10'] = total  # 硬编码 5000，源数据变了就过期
growth = (new - old) / old
sheet['C5'] = growth  # 硬编码 0.15
\`\`\`

✅ 正确 — 用 Excel 公式:
\`\`\`python
sheet['B10'] = '=SUM(B2:B9)'
sheet['C5'] = '=(C4-C2)/C2'
sheet['D20'] = '=AVERAGE(D2:D19)'
\`\`\`
所有计算（合计、百分比、增长率、均值）都必须用公式，确保电子表格可动态更新。

## 财务建模颜色标准
- 蓝色文字 (0,0,255): 硬编码输入值/假设值（用户可修改的数字）
- 黑色文字 (0,0,0): 所有公式和计算
- 绿色文字 (0,128,0): 跨 sheet 引用
- 红色文字 (255,0,0): 外部文件链接
- 黄色背景 (255,255,0): 需要关注的关键假设

## 数字格式规范
- 年份: 文本格式 "2024"（不要显示为 "2,024"）
- 货币: $#,##0 格式，表头注明单位 "Revenue ($mm)"
- 零值: 显示为 "-"，格式串 "$#,##0;($#,##0);-"
- 百分比: 0.0% 格式（一位小数）
- 负数: 用括号 (123) 而非减号 -123

## 公式构造规则
1. 所有假设值（增长率、利润率等）放在独立单元格，公式用 cell reference
   ✅ =B5*(1+$B$6)  而非  =B5*1.05
2. 验证所有 cell reference 指向正确单元格
3. 注意 off-by-one: DataFrame row 5 = Excel row 6（Excel 1-indexed）
4. 跨 sheet 引用格式: Sheet1!A1
5. 除法前检查分母是否为零（避免 #DIV/0!）

## 工作流程
1. 选工具: pandas 处理数据 → openpyxl 添加公式/格式
2. 创建/加载 workbook
3. 写入数据和公式
4. 应用格式和样式
5. 保存文件
6. 公式重算验证（如果系统有 LibreOffice）:
   \`\`\`bash
   python3 ~/.code-agent/skills/anthropic-skills/skills/skills/xlsx/recalc.py output.xlsx
   \`\`\`
   返回 JSON: status/total_errors/error_summary，有错误则修复后重新运行

## 常见公式错误
- #REF! → 无效的单元格引用（检查是否删除了被引用的行/列）
- #DIV/0! → 分母为零（加 IF 判断）
- #VALUE! → 公式中数据类型错误
- #NAME? → 函数名拼写错误
- #N/A → VLOOKUP/INDEX 未找到匹配

## 图表
需求涉及占比、趋势、对比等可视化意图时，输出中应包含对应图表。
openpyxl.chart 可嵌入 xlsx，matplotlib 可生成独立 png。图表和数据表同等重要，不能省略。

## openpyxl 注意事项
- load_workbook(data_only=True) 读计算值，但保存后公式会丢失！
- 大文件用 read_only=True / write_only=True
- 公式写入后未 recalc 前，Excel 打开可能显示旧缓存值

## 代码风格
写简洁的 Python，不加多余注释和 print。Excel 文件内：复杂公式加 cell comment 说明。`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'read_xlsx', 'write_file', 'edit_file'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    bins: ['python3'],
  },
];

/**
 * 获取所有内置 Skills
 */
export function getBuiltinSkills(): ParsedSkill[] {
  return BUILTIN_SKILLS;
}

/**
 * 按名称获取内置 Skill
 */
export function getBuiltinSkill(name: string): ParsedSkill | undefined {
  return BUILTIN_SKILLS.find(skill => skill.name === name);
}

/**
 * 检查是否为内置 Skill
 */
export function isBuiltinSkill(name: string): boolean {
  return BUILTIN_SKILLS.some(skill => skill.name === name);
}
