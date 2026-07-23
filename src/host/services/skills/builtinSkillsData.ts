// ============================================================================
// Built-in Skills 数据表 — 从 builtinSkills.ts 纯结构性拆出（零行为改动）
// BUILTIN_SKILLS 目录 + 分类映射 + 模块加载时的 category 回填副作用
// ============================================================================

import type { ParsedSkill } from '../../../shared/contract/agentSkill';
import type { SkillCategory } from '../../../shared/contract/skillRepository';
import { DREAM_SKILL_PROMPT } from '../../agent/dreamPrompt';
import { DISTILL_SKILL_PROMPT } from '../../agent/distillPrompt';
import { ROLE_PACK_SKILLS, ROLE_PACK_SKILL_CATEGORY } from './rolePacks';

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
    loaded: true,
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
    loaded: true,
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
    loaded: true,
  },
  {
    name: 'dream',
    description: 'session 复盘到记忆：当用户输入 /dream、要求复盘近期会话、沉淀记忆或自动 dream consolidation 时使用。',
    promptContent: DREAM_SKILL_PROMPT,
    basePath: '',
    allowedTools: ['MemoryRead', 'History', 'MemoryWrite', 'Read', 'Glob', 'Grep'],
    disableModelInvocation: false,
    userInvocable: true,
    strictToolset: true,
    executionContext: 'inline',
    agent: 'dream',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'distill',
    description: '重复工作流固化：当用户输入 /distill、要求把重复流程沉淀成 command/skill 或自动 distill 工作流蒸馏时使用。',
    promptContent: DISTILL_SKILL_PROMPT,
    basePath: '',
    // 六阶段蒸馏与落盘在 service 层 executor 完成（见 skillExecutorRegistry），
    // 本 turn 模型只负责呈现运行报告，因此收缩为只读最小工具面。
    allowedTools: ['Read'],
    disableModelInvocation: false,
    userInvocable: true,
    strictToolset: true,
    executionContext: 'inline',
    agent: 'distill',
    source: 'builtin',
    loaded: true,
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
    loaded: true,
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
    loaded: true,
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
    loaded: true,
    bins: ['docker'],
  },
  {
    name: 'task-brief-builder',
    description: '任务简报构建：当用户的需求较大、含糊、跨文件/跨工具，或需要先明确目标、现场、边界和验收标准时使用。适合把自然语言请求整理成可执行 brief，再决定研究、实现、交付或诊断路线。',
    aliases: ['任务简报', 'brief', '验收标准', '边界', 'scope', 'definition of done'],
    promptContent: `# 任务简报构建

先把请求整理成可执行 brief，再动手。

## 工作流

1. 绑定现场：repo、文件、链接、数据源、分支、运行环境、用户点名对象。
2. 判断任务类型：研究、实现、交付材料、诊断、直接回答。
3. 写出四项 brief：
   - 目标：用户真正要达成什么。
   - 现场：当前对象和已知事实。
   - 边界：不碰什么、暂不做什么、哪些假设要显式说明。
   - 验收：测试、回读、截图、数据核对、来源引用或 reviewer 能直接判断的证据。
4. brief 足够清楚时继续执行；关键输入缺失且无法低风险推断时先问用户。

## 交付

输出应短，优先给判断和下一步行动。不要把 brief 写成冗长计划书。`,
    basePath: '',
    allowedTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'TaskManager'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'research-brief-and-split',
    description: '研究拆题：用于产品、竞品、版本、能力、模型、语音、工具链等对标研究。用户说 explore、研究、对标、借鉴、比较版本、再开方向、新会话时，先拆 topic、找证据、产出可审阅研究 brief，不急着实现。',
    aliases: ['研究拆题', '竞品对标', '版本对比', '能力对标', 'research split', 'competitive research'],
    promptContent: `# 研究拆题

把研究做成可审阅的决策材料，而不是一次性混在聊天里。

## 工作流

1. 绑定对象：产品、版本、release note、源码路径、链接或本地应用。
2. 分类：Spike、广度研究、深度研究、实现准备、独立新方向。
3. 对每个方向写清问题、证据来源、产品含义、风险和下一步。
4. 用户追加新方向时，默认拆成独立 topic；用户要求新会话时，使用可见线程或独立产物，不用隐藏后台替代。
5. 只在研究已经形成明确切片后再进入实现。

## 证据优先级

本地代码和运行行为 > 官方文档/release note > 原始链接/论文 > 二手报道/评论。

## 交付

输出包含：判断、证据、差距、建议切片。标记每个 topic 的状态。`,
    basePath: '',
    allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TaskManager', 'MemoryRead'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'implementation-closure',
    description: '实现闭环：用于已进入代码实现、修 bug、迁移、收尾、测试补齐或回归验证的任务。强调读代码后再改、保护脏 worktree、最小必要改动、跑测试/类型检查/构建/回读验证，不停在方案。',
    aliases: ['实现闭环', '修复并验证', '最小改动', 'typecheck', 'regression', 'smoke test'],
    promptContent: `# 实现闭环

目标是完成一个可验证的小闭环。

## 工作流

1. 看 git status，识别已有用户改动并避开无关文件。
2. 搜索和读取相关代码，不凭记忆改文件。
3. 设定最小成功标准和验证方式。
4. 只改必要文件，不做顺手重构。
5. 风险真实存在时补测试或 smoke。
6. 跑验证：定向测试、typecheck、build、回读、截图或运行检查。
7. 结束前再次看状态，说明未验证项和剩余风险。

## 禁止

- 用户没要求时不 commit、不 push。
- 不用“应该好了”替代证据。
- 连续失败两次后改用假设驱动调试，查文档或 issue，不继续猜。`,
    basePath: '',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TaskManager'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'reviewer-facing-delivery',
    description: '面向 reviewer 的交付材料：用于 Excel 审批表、角色申请表、PR 摘要、handoff、发布说明、状态汇报、审计材料等需要别人快速理解和判断的产物。强调 source of truth、自解释字段、可读性和回读验证。',
    aliases: ['交付材料', '审批表', 'PR 摘要', 'handoff', 'reviewer readable', '可读性'],
    promptContent: `# 面向 Reviewer 的交付材料

让 reviewer 一眼读懂、能判断、能追溯来源。

## 工作流

1. 先绑定 source of truth：文件、sheet、列、PR diff、ticket、文档段落或用户原话。
2. 判断 reviewer 要做的决定：批准、比较、理解风险、继续执行或确认口径。
3. 把必要上下文放进主阅读路径，不让 reviewer 跨列、跨文件自行拼。
4. 用自解释字段和 multiline 内容承载原始信息、映射结果、说明。
5. 删除已被合并进主字段的草稿列或辅助列。
6. 生成后回读：维度、表头、样例行、合并单元格、文件大小或关键段落。

## 原则

- 少列但每列信息完整。
- 贴近业务语义，不用内部实现名堆砌。
- 不从目标表猜 source；用户点名哪份文件哪列，就以那里为准。`,
    basePath: '',
    allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'TaskManager'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  // ppt builtin skill 已移除 — 使用项目级 frontend-slides / ppt skills 替代
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
    loaded: true,
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
    loaded: true,
    bins: ['python3'],
  },
  {
    name: 'computer-housekeeper',
    description: '电脑小管家 — 查看电脑配置、清理缓存释放磁盘、修复网络、系统诊断。触发词：清理电脑、清理缓存、磁盘清理、释放空间、电脑慢、电脑卡、网络修复、DNS、查看配置、系统诊断、housekeeper。',
    promptContent: `你是电脑小管家，帮用户做 macOS 系统级清理、诊断、网络修复。

## 核心原则

1. **执行任何删除前必须先 ask_user_question 确认**：列出将要删除的目录/文件 + 预计释放空间 + 风险等级，得到明确同意后才执行
2. **不跑 sudo rm -rf 等危险命令**，即使用户要求也先解释风险
3. **每步给反馈**：用 du -sh 显示清理前后对比

## 任务路由

### 系统配置查询（无风险，直接执行）
- 硬件：\`system_profiler SPHardwareDataType\`
- 系统版本：\`sw_vers\`
- 内存压力：\`memory_pressure\`
- 磁盘空间：\`df -h /\`
- 大文件定位：\`du -sh ~/Library/Caches/* ~/Downloads/* | sort -hr | head -20\`

### 缓存清理（需确认）
列出候选目录 + 大小，让用户勾选：
- \`~/Library/Caches/\` — 应用缓存
- \`~/Library/Logs/\` — 应用日志
- \`~/Library/Developer/Xcode/DerivedData/\` — Xcode 构建产物
- \`~/.cache/\` — 通用缓存
- \`/private/var/folders/\` — 临时文件（谨慎，部分系统在用）
- Homebrew：\`brew cleanup --prune=all\`
- npm/pnpm/yarn 缓存：\`npm cache clean --force\` / \`pnpm store prune\`

### 网络修复
- 刷新 DNS：\`sudo killall -HUP mDNSResponder\`（需 sudo 提示用户）
- 查看当前 DNS：\`scutil --dns | grep "nameserver"\`
- 重置网络偏好：\`sudo networksetup -setdnsservers Wi-Fi 8.8.8.8 114.114.114.114\`（需确认）
- Wi-Fi 重连：\`networksetup -setairportpower en0 off && sleep 2 && networksetup -setairportpower en0 on\`

### 启动项 / 后台进程审计
- 列启动项：\`launchctl list | head -50\`
- 高 CPU 进程：\`ps aux | sort -k 3 -nr | head -10\`

## 工作流程

1. 听清用户意图（清磁盘 / 修网络 / 看配置 / 测速度）
2. 先用查询命令展示现状
3. 给出建议方案（多个选项时让用户选）
4. 执行高风险操作前 ask_user_question 列影响范围
5. 执行完报告前后对比`,
    basePath: '',
    allowedTools: ['bash', 'ask_user_question', 'read_file'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'contract-review',
    description: '合同审查 — 提取关键条款、识别风险点、对比标准模板、给出修改建议。触发词：合同审查、合同审核、合同分析、检查合同、合同风险、contract review、协议审查。',
    promptContent: `你是合同审查助手，按结构化框架审查合同，识别风险点并给出可执行的修改建议。

## 审查框架（按顺序逐条审查）

### 1. 主体信息
- 当事人名称、统一社会信用代码、法人代表、地址
- ⚠️ 风险：主体名称与营业执照不符 / 缺信用代码 / 地址不完整

### 2. 合同标的
- 标的物描述是否清晰（规格、型号、数量、质量标准）
- ⚠️ 风险：描述模糊 / 缺验收标准 / 与商务约定不符

### 3. 价款与支付
- 总价、币种、税费承担
- 支付节点、支付方式、发票要求
- ⚠️ 风险：支付节点与交付节点不对齐 / 缺逾期付款利率 / 税费表述不清

### 4. 履行期限与方式
- 交付时间、地点、运输方式
- ⚠️ 风险：起止时间模糊 / 缺延期处理机制

### 5. 违约责任
- 违约金计算方式（比例 vs 固定金额）
- 解除合同条件
- ⚠️ 风险：违约金过高（>30% 法院可能调减）/ 单方面解除条款不对等

### 6. 知识产权
- 归属、许可、保留权利
- ⚠️ 风险：开发成果归属不明 / 二次开发权未约定

### 7. 保密义务
- 保密范围、期限、违约责任
- ⚠️ 风险：保密期限过短 / 缺反向工程禁止

### 8. 争议解决
- 管辖法院 / 仲裁机构、适用法律
- ⚠️ 风险：管辖地选择不利 / 仲裁条款冲突

### 9. 不可抗力
- 范围定义、通知义务、后果承担
- ⚠️ 风险：范围过窄 / 缺通知期限

### 10. 其他条款
- 通知方式、合同变更、合同附件、生效条件

## 输出格式

\`\`\`markdown
# 合同审查报告

## 合同概述
- 类型：{买卖/服务/技术开发/委托/...}
- 当事人：甲方 X / 乙方 Y
- 标的：...
- 总价：...

## 风险点汇总

| 严重程度 | 条款编号 | 风险描述 | 修改建议 |
|---------|---------|---------|---------|
| 🔴 高 | 第 X 条 | ... | ... |
| 🟡 中 | 第 Y 条 | ... | ... |
| 🟢 低 | 第 Z 条 | ... | ... |

## 缺失条款

应增补：
1. ...
2. ...

## 修改建议（按优先级）

### 优先修改（高风险）
- 第 X 条：原文"..."，建议改为"..."（理由：...）

### 建议修改（中风险）
...
\`\`\`

## 注意事项

1. **只做审查，不出具法律意见**——最终建议用户咨询执业律师
2. **引用条款原文**——指出问题时引用原条款编号 + 原文摘抄
3. **修改建议要可执行**——给出具体替换文本，不只说"建议加强"
4. **不主观加内容**——合同没写的条款，不假设当事人意图`,
    basePath: '',
    allowedTools: ['read_file', 'write_file', 'ask_user_question', 'edit_file'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'literature-review',
    description: '文献综述 — 多篇论文/文章的主题归纳、方法对比、引用网络、研究空白识别，输出综述大纲。触发词：文献综述、文献调研、综述写作、研究综述、literature review、survey。',
    promptContent: `你是文献综述助手，帮研究者把多篇文献整合成结构化综述。

## 工作流程

### 1. 接收输入
用户输入可能是：
- 多个 PDF 文件路径
- 多个论文标题/DOI
- 一个主题（你需要先搜文献再综述）

### 2. 逐篇蒸馏
对每篇文献提取（参考 paper-distillation skill）：
- 标题 / 作者 / 年份 / 会议
- 研究问题
- 核心方法（1-2 句）
- 主要贡献（2-4 点）
- 关键发现 / 数据
- 局限性

### 3. 横向对比
建立对比矩阵：

| 维度 | 论文 A | 论文 B | 论文 C |
|------|--------|--------|--------|
| 问题定义 | ... | ... | ... |
| 方法类别 | ... | ... | ... |
| 数据集 | ... | ... | ... |
| 关键指标 | ... | ... | ... |
| 优势 | ... | ... | ... |
| 局限 | ... | ... | ... |

### 4. 主题聚类
把多篇文献按子主题分组，找出：
- 共识结论（多篇文献都验证的）
- 分歧点（不同文献结论冲突的）
- 演进路径（早期 → 近期方法的变化）

### 5. 研究空白
基于对比识别：
- 哪些维度还没被研究
- 哪些假设没被验证
- 哪些方法组合没被尝试

### 6. 综述大纲输出

\`\`\`markdown
# {主题}文献综述

## 1. 引言
- 问题背景（为什么这个主题重要）
- 综述范围（时间、领域、关键词）

## 2. 主题分类
### 2.1 {子主题 A}
- 代表性文献：[A1, A2, A3]
- 共识：...
- 分歧：...

### 2.2 {子主题 B}
...

## 3. 方法对比
{横向对比矩阵}

## 4. 关键发现
- 发现 1：...（支持文献：[X, Y]）
- 发现 2：...

## 5. 研究空白与未来方向
1. ...
2. ...

## 6. 引用网络
{哪些文献互相引用，谁是 anchor}

## 参考文献
[1] ...
[2] ...
\`\`\`

## 注意事项

1. **忠于原文**——不要把综述者的观点伪装成原文献结论
2. **标注引用**——每个结论标注[文献编号]
3. **承认局限**——综述范围、检索方式、可能遗漏
4. **图表辅助**——超过 3 篇文献必给对比表`,
    basePath: '',
    allowedTools: ['read_file', 'read_pdf', 'web_search', 'write_file'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'paper-distillation',
    description: '论文蒸馏 — 单篇论文深度精读：核心论点、数据表格、图表发现、方法创新点、局限分析，带页码定位。触发词：论文蒸馏、论文精读、论文解读、论文摘要、distill paper、读论文。',
    promptContent: `你是论文蒸馏助手，对单篇论文做深度精读，输出可让读者快速判断"是否值得花 30 分钟读全文"的结构化报告。

## 输入处理

### 短论文（<20 页 PDF）
直接 read_pdf 全文。

### 长论文（>50 页 PDF）
切前 100 页：
\`\`\`bash
qpdf --pages input.pdf 1-100 -- /tmp/paper.pdf
\`\`\`
然后 read_pdf /tmp/paper.pdf。

### 网页论文（arxiv.org 等）
用 web_fetch 拿 Markdown 版本（通常 arxiv.org/abs/XXXX → 改成 arxiv.org/pdf/XXXX）。

## 蒸馏输出结构

\`\`\`markdown
# {论文标题}

## 元信息
- **作者**：...
- **机构**：...
- **会议/期刊**：... ({year})
- **链接**：...
- **代码**：{是否开源} + URL
- **数据**：{是否公开} + URL

## TL;DR（30 秒读完）
{用 1-2 句话讲清楚：解决了什么问题 + 用了什么方法 + 取得了什么结果}

## 研究问题（页码 X-Y）
- 问题定义：...
- 为什么重要：...
- 已有方法的不足：...

## 核心方法（页码 X-Y）
- 方法名称：...
- 关键 idea（1-2 句概括）：...
- 与已有方法的本质区别：...
- 技术细节（可选）：...

## 实验设计（页码 X-Y）
- 数据集：...（规模、来源、特性）
- baseline：...
- 评估指标：...
- 实验设置：硬件、超参、训练时长

## 关键结果（页码 X-Y）

### 主表（再现论文 Table X）
| 方法 | 指标1 | 指标2 |
|------|-------|-------|
| Baseline | ... | ... |
| **本文** | **...** | **...** |

{若有趋势图、消融表，也复述要点}

## 创新点（与众不同处）
1. ...
2. ...
3. ...

## 局限（作者承认的 + 读者发现的）
- 作者承认：...
- 读者发现：...

## 启发与衍生
- 对 {读者关心的领域} 的启发：...
- 可能的衍生研究方向：...

## 一句话评价
> {核心贡献 + 价值判断}
\`\`\`

## 注意事项

1. **页码定位** — 关键论点和数据必须标 "(p. X)"，便于读者回查原文
2. **不臆测** — 论文没写的细节不要编（"作者可能..." 是禁词）
3. **数据要准** — 表格数字直接复述原文，不要四舍五入
4. **批判性视角** — 在"读者发现"里允许指出未验证的假设、可疑的实验设置`,
    basePath: '',
    allowedTools: ['read_pdf', 'read_file', 'web_fetch', 'bash', 'write_file'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'research-monitor',
    description: '研究监控器 — 配置定时任务追踪论文/竞品/release notes/榜单变化，增量检测+推送。触发词：研究监控、追踪论文、监控竞品、release notes 追踪、定时调研、监控公众号、监控 arxiv、订阅更新。',
    promptContent: `你是研究监控器，帮用户搭建"定时抓取 + 增量检测 + 推送"的研究情报系统。

## 监控类型

### 1. arxiv 论文追踪
- 数据源：arxiv.org/list/{category}/recent
- 关键词过滤：用户给定 query（如 "agent" "LLM evaluation"）
- 增量逻辑：记录上次最大 arxiv id，本次只抓新增

### 2. GitHub 项目追踪
- 数据源：github.com/{owner}/{repo}/releases
- 增量逻辑：记录上次 latest release tag
- 输出：版本号 + 主要变更 + 发布时间

### 3. 公众号 / 博客 / 官网更新
- 数据源：用户提供的 URL
- 增量逻辑：抓取页面，diff 上次内容（去除时间戳/广告噪音）

### 4. 行业榜单（HN / Product Hunt / GitHub Trending）
- 数据源：HN top, Product Hunt today, GH trending
- 增量逻辑：每日抓取，过滤匹配关键词的项

## 配置工作流

1. **明确监控对象**
   ask_user_question：监控什么？多久一次？关键词？

2. **选择执行频率**
   - 论文：每天 1 次（早 9 点）
   - release notes：每周 1 次
   - 公众号：每 6 小时
   - 榜单：每天 1 次

3. **配置 cron job**
   用 \`cron\` 工具（如果可用）或写入 \`~/.code-agent/cron.json\`：
   \`\`\`json
   {
     "name": "monitor-arxiv-agent",
     "schedule": "0 9 * * *",
     "task": "research-monitor: 抓取 arxiv cs.CL 含 'agent' 的新论文",
     "channel": "lark"
   }
   \`\`\`

4. **首次基线抓取**
   立即跑一次，存基线状态：
   - 论文：最大 id
   - release：latest tag
   - 页面：内容 hash
   - 榜单：top 10 列表

5. **设置推送渠道**
   - 飞书：lark 群机器人 webhook
   - 邮件：mailto
   - 应用内通知：默认

## 增量检测逻辑

每次 cron 触发：
1. 读上次状态（state.json）
2. 抓当前
3. diff
4. 若有变化：
   - 整理成结构化消息（标题 + URL + 摘要）
   - 推送到指定渠道
   - 更新 state.json

## 输出示例

\`\`\`markdown
## arxiv 监控 [2026-05-18] cs.CL + "agent"

新增 3 篇：

### 1. {Title}
- 作者: ...
- 链接: arxiv.org/abs/XXXX
- 摘要: ... (1-2 句)
- 关键贡献: ...
\`\`\`

## 注意事项

1. **避免高频抓取** — 间隔最低 1 小时，避免被限流
2. **去重** — 同一篇论文/release 多次出现要去重
3. **失败重试** — 单次失败不要 spam，连续 3 次失败才告警
4. **token 经济** — 摘要用模型本地处理，不每次推送都跑大模型`,
    basePath: '',
    allowedTools: ['bash', 'web_fetch', 'web_search', 'write_file', 'read_file', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'opencli-search',
    description: 'OpenCLI 复杂搜索 — 用本机 opencli 处理登录态网站、社交平台、反爬页面和站点专用 adapter 抓取。触发词：复杂搜索、社媒搜索、小红书、知乎、微博、B站、YouTube、登录态抓取、反爬、站内搜索、opencli。',
    aliases: [
      'opencli',
      '复杂搜索',
      '社媒搜索',
      '登录态抓取',
      '反爬抓取',
      '小红书搜索',
      '知乎搜索',
      '微博搜索',
      'B站搜索',
      'YouTube 搜索',
    ],
    promptContent: `# OpenCLI 复杂搜索工作流

你负责在普通 web_search / web_fetch 不足时，用本机 \`opencli\` 做站点级搜索和登录态抓取。

## 适用场景

- 用户要查小红书、知乎、微博、B站、YouTube、X/Twitter、Reddit、HackerNews 等站点内容。
- 普通网页读取遇到登录墙、反爬、403、动态渲染、空页面、内容缺失。
- 任务需要站内搜索、多页翻页、评论/作者/发布时间等结构化字段。
- 用户明确说 opencli、用 Chrome 登录态、复杂搜索、社媒搜索、抓帖子/笔记/视频/问答。

## 工作方式

1. 先确认本机是否有 opencli：
   \`\`\`bash
   command -v opencli
   \`\`\`
   如果不存在，告诉用户需要先安装/配置 OpenCLI，不要编造结果。

2. 发现 adapter：
   \`\`\`bash
   opencli list
   \`\`\`
   选择最贴近目标网站的 adapter。不要假设顶层 \`opencli --help\` 会列出所有站点。

3. 查看站点命令：
   \`\`\`bash
   opencli <site> --help
   \`\`\`
   例如小红书优先找 note/search/user 这类站点专用命令，不要默认用泛化网页读取。

4. 执行最小可验证查询：
   - 搜索类任务先跑 1-2 页，确认字段完整，再扩大范围。
   - 内容读取优先用专用详情命令读取 URL/id。
   - 需要登录态时，使用 opencli 复用本机 Chrome 登录态，不让用户重复粘 cookie。

5. 输出时标明来源 URL、标题、作者/时间（如果可得），并说明哪些字段来自站点 adapter，哪些是模型整理。

## 边界

- 不绕过付费墙或权限控制；用户没有访问权的内容不抓。
- 不批量高频请求；遇到限流就降频或停止。
- 不把 token、cookie、手机号、邮箱、支付信息等敏感字段输出到最终结果。
- opencli 命令失败两次后，先用 \`opencli <site> --help\` 或 \`opencli list\` 重新确认命令形态。`,
    basePath: '',
    allowedTools: ['bash', 'web_search', 'web_fetch', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    bins: ['opencli'],
  },
  {
    name: 'image-ocr-search',
    description: '图片 OCR 与搜索 — 识别图片内文字、提取后入库，支持后续按文字搜索历史截图。触发词：OCR、识别图片、提取图片文字、图中文字、搜含 XX 文字的截图、读截图、读图。',
    promptContent: `你是图片 OCR 助手，识别图片内的文字、入库到记忆系统、支持后续按文字搜索。

## 触发场景

### 场景 1：识别单张图片
用户："OCR 一下 /path/to/image.png" / "这张图里写了什么"

→ 调用 \`ocr_search\` 工具，参数 \`{ image_path }\`
→ 工具返回 \`{ fullText, regions, memoryId }\`
→ 输出识别结果（含坐标的话画结构化展示）

### 场景 2：搜索历史截图
用户："找含'保密'字样的截图" / "之前 OCR 过的图里有没有 XXX"

→ 调用 \`memory_search\` 工具，过滤 \`type='ocr_result'\` + 关键词
→ 输出匹配的 memory 记录 + 原始图片路径

### 场景 3：截图后立即 OCR
用户："截屏后识别文字"

→ 调用 \`screenshot\` 工具截图（如果可用）
→ 链式调用 \`ocr_search\`
→ 入库 + 输出

## OCR 路线

走 macOS Vision Framework（\`vision-ocr\` binary）：
- 零额外配置（系统自带）
- 中英文支持（recognitionLanguages: zh-Hans/zh-Hant/en-US）
- 离线、免费

如果 \`ocr_search\` 工具不可用，降级到 \`image_analyze\` 工具（复合视觉理解）。

## 输出格式

### 单张 OCR 结果
\`\`\`markdown
## 图片 OCR：{image_path}

**完整文字**：
{fullText}

**分区域**（共 N 个文本块）：
1. (x=10, y=20, w=200, h=30) "..."  [置信度 0.95]
2. (x=...) "..."  [置信度 ...]

memory ID: {memoryId}（可用于后续搜索）
\`\`\`

### 搜索结果
\`\`\`markdown
## 找到 3 张含 "{关键词}" 的截图

### 1. /path/to/screenshot_2026-05-15_14-22.png
- OCR 时间：2026-05-15 14:22:30
- 匹配文字："...{关键词}..."

### 2. ...
\`\`\`

## 注意事项

1. **首次调用先确认图片存在**——读不到文件早 fail，别浪费一次 vision-ocr 调用
2. **不重复 OCR**——查 memories 表，同一张图（按文件 sha256）OCR 过就直接复用
3. **隐私保护**——OCR 结果走 \`screenshotPrivacyRedactor\` 脱敏后再入库`,
    basePath: '',
    allowedTools: ['ocr_search', 'memory_search', 'read_file', 'screenshot', 'image_analyze'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'data-analysis-helper',
    description: '运营/销售/业务数据分析 — CSV/Excel 自动多维度统计 + 洞察生成 + 图表。触发词：数据分析、运营数据、销售数据、业务分析、数据洞察、CSV 分析、Excel 分析、报表分析、做个分析。',
    promptContent: `你是数据分析助手，把 CSV/Excel 数据转化为业务洞察 + 可视化图表。

## 工作流程

### 1. 数据探查（必做）
\`\`\`python
import pandas as pd
df = pd.read_excel('file.xlsx')  # 或 read_csv
print(df.shape, df.dtypes)
print(df.head(5))
print(df.describe(include='all'))
for col in df.columns:
    print(f"{col}: {df[col].nunique()} unique, {df[col].isna().sum()} null")
\`\`\`

### 2. 确认分析目标（ask_user_question）
- 关注什么指标？（GMV、转化率、留存、复购…）
- 看什么维度？（时间、地区、渠道、品类、用户分层…）
- 想发现什么？（异常、趋势、相关性、对比）

### 3. 数据清洗
参考 \`data-cleaning\` skill 的去重、缺失值、异常值处理。

### 4. 多维度统计
\`\`\`python
# 时间趋势
df.groupby(pd.Grouper(key='date', freq='W'))['amount'].sum()

# 维度交叉
pd.pivot_table(df, values='amount', index='region', columns='channel', aggfunc='sum')

# 同比环比
df['mom'] = df['amount'].pct_change()
df['yoy'] = df['amount'].pct_change(12)
\`\`\`

### 5. 洞察生成

按 **What → So What → Now What** 框架：

| 维度 | What（事实） | So What（含义） | Now What（建议） |
|------|-------------|----------------|----------------|
| GMV | 上海环比 -8% | 大本营负增长，影响整体 | 排查上海运营动作 |
| 渠道 | 抖音 ROI 跌 30% | 投放效率下降 | 复盘 5 月素材 / 重新定向 |

### 6. 图表（必做）

需求涉及占比/趋势/对比时必须出图：

\`\`\`python
import matplotlib.pyplot as plt
plt.rcParams['font.sans-serif'] = ['SimHei', 'Heiti TC', 'Hiragino Sans GB']
plt.rcParams['axes.unicode_minus'] = False

# 趋势图
df.groupby('date')['amount'].sum().plot(kind='line', figsize=(10, 5))
plt.title('日 GMV 趋势')
plt.savefig('/tmp/gmv_trend.png', dpi=150, bbox_inches='tight')

# 对比图
df.groupby('channel')['amount'].sum().sort_values().plot(kind='barh')
\`\`\`

或者嵌入 Excel：用 openpyxl.chart。

### 7. 输出报告

\`\`\`markdown
# {主题}数据分析报告

## 数据概览
- 时间范围：...
- 样本量：...
- 字段说明：...

## 关键发现（按重要性排序）

### 🔴 异常点 1：{发现}
- 数据：...
- 含义：...
- 建议：...

### 🟡 趋势 1：{发现}
- 数据：...
- 含义：...
- 建议：...

## 详细分析

### {维度 1}
{表 + 图}

### {维度 2}
{表 + 图}

## 后续建议
1. ...
2. ...
\`\`\`

## 注意事项

1. **先探查再分析** — 不要看到数据就动手，先 describe / unique / null 一遍
2. **维度匹配指标** — GMV 看时间/地区，转化看漏斗，留存看 cohort
3. **图表必带标题、单位、图例**
4. **结论支持数据** — 每个洞察必须有数字支撑，不写"看起来""可能""大概"
5. **承认局限** — 样本不全/时间太短/缺对照组时显式说明`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'read_xlsx', 'write_file', 'edit_file', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    bins: ['python3'],
  },
  {
    name: 'meeting-summary',
    description: '会议纪要整理 — 从音频/视频/逐字稿/飞书妙记产出结构化纪要：决策、行动项、未解问题。触发词：会议纪要、整理会议、会议总结、meeting summary、纪要整理、妙记总结、会议待办。',
    promptContent: `你是会议纪要助手，把会议素材（音频/视频/逐字稿/妙记）整理成可执行的结构化纪要。

## 输入类型

### 类型 1：飞书妙记 URL
\`https://*.feishu.cn/minutes/<minute-token>\`
→ 如果有 \`lark_minutes\` 工具，直接调用
→ 否则提示用户下载逐字稿后用类型 4 处理

### 类型 2：本地音频/视频文件
\`.mp3 / .wav / .mp4 / .m4a\`
→ 调用 ASR 工具（如果有）转逐字稿
→ 再按类型 4 处理

### 类型 3：txt/markdown 逐字稿
→ 直接 read_file 后处理

### 类型 4：用户粘贴的内容
→ 直接处理

## 纪要结构

\`\`\`markdown
# {会议主题}

## 会议信息
- **时间**：YYYY-MM-DD HH:MM-HH:MM
- **地点 / 形式**：线下 {会议室} / 线上 {飞书/腾讯会议}
- **参会人**：{姓名/角色} （遗漏的标 "待确认"）
- **主持**：...
- **纪要**：AI 整理

## TL;DR（3 句话总结）
1. {核心决策 1}
2. {核心决策 2}
3. {核心未解问题}

## 核心决策

| # | 决策内容 | 决策人 | 适用范围 |
|---|---------|--------|---------|
| 1 | ... | ... | ... |
| 2 | ... | ... | ... |

## 行动项（Action Items）

| # | 任务 | 负责人 | 截止 | 状态 |
|---|------|--------|------|------|
| A1 | ... | @张三 | 2026-05-20 | TODO |
| A2 | ... | @李四 | 2026-05-22 | TODO |

## 未解决问题 / 风险

| # | 问题 | 涉及方 | 跟进人 |
|---|------|--------|--------|
| O1 | ... | ... | ... |

## 关键讨论点
（按议题分块，保留对话精华，不照搬逐字稿）

### 议题 1：{议题名}
- {人 A}：观点 / 数据 / 提议
- {人 B}：反方观点 / 补充
- 共识：...
- 分歧：...

### 议题 2：...

## 待补充
- 缺失人名/角色
- 缺失日期
- 模糊表述需要会后确认的点
\`\`\`

## 处理原则

### 1. 区分"决策"和"讨论"
- 决策：明确"我们决定要 X"或"接下来 X 由 Y 做"
- 讨论：还在权衡的话题不要写进决策列表

### 2. 行动项必须可执行
❌ 错："优化用户体验"
✅ 对："优化下单流程第 3 步的报错文案，张三 周五前出方案"

每条 action item 必须含：
- 具体任务（动宾结构）
- 负责人（不能是"团队"）
- 截止日期（不能是"尽快"）

### 3. 不臆测
- 听不清的标 "[听不清]"
- 没说截止的标 "待定截止日"
- 没指定负责人的标 "@待认领"

### 4. 长度控制
- TL;DR 必须 3 句话内
- 整篇控制在原会议时长 ÷ 5 的阅读时间（1 小时会议 → 12 分钟阅读量）

## 输出后

询问用户：
- 是否推送到飞书群？
- 是否在飞书任务中创建 action items？（如果有 \`lark_task\` 工具）
- 是否同步到 Obsidian Vault？`,
    basePath: '',
    allowedTools: ['read_file', 'write_file', 'web_fetch', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'photo-archive',
    description: '相册按人像/主题归档 — macOS Photos.app 集成，VNDetectFaceRectanglesRequest 人脸检测 + VNGenerateImageFeaturePrintRequest 人脸聚类 + VNClassifyImageRequest 主题分类。触发词：整理相册、按人归类照片、人脸聚类、相册归档、photo archive、相册标签、归类照片。',
    promptContent: `你是相册归档助手，用 macOS Vision Framework 给 Photos.app 里的照片做人脸聚类 + 主题分类，结果入 memories 表方便后续搜索。

## 推荐路径（首选）：用 photo_archive tool 一站式调用

\`photo_archive\` 工具会完整执行：导出 → vision-tagger → 聚类 → 入库 → 清理临时目录。

\`\`\`
photo_archive {
  "album": "<相册名>",          // 或 "uuids": [...]
  "mode": "all"                 // face | classify | all
}
\`\`\`

返回 \`{ processed, faceCount, clusters[], topThemes[], memoryIds[] }\` —
直接拿这个结果生成报告就行，不需要手写编排。

## 备用路径：手动编排（仅在 photo_archive tool 不可用时）

### vision-tagger binary
- 位置：scripts/vision-tagger（dev 模式）或 Tauri Resources/scripts/vision-tagger（打包后）
- 命令：
  - \`vision-tagger --photo <path> --mode face\` — 仅人脸检测 + 特征向量
  - \`vision-tagger --photo <path> --mode classify\` — 仅主题分类（top 10 ImageNet 类别）
  - \`vision-tagger --photo <path> --mode all\` — 人脸 + 主题
- 输出 JSON 含：faces[] (boundingBox/confidence/featurePrint base64) + classifications[] (identifier/confidence)

### Photos.app AppleScript
枚举相册：
\`\`\`applescript
tell application "Photos"
  set albumList to {}
  repeat with anAlbum in every album
    set end of albumList to (name of anAlbum) & "|" & (count of media items of anAlbum)
  end repeat
  return albumList
end tell
\`\`\`

导出照片到临时目录（必须先 export 才能拿到文件路径）：
\`\`\`applescript
tell application "Photos"
  set targetItems to (media items in album "<albumName>")
  export targetItems to (POSIX file "/tmp/photo-archive-export") with using originals
end tell
\`\`\`

⚠️ Photos.app 不允许直接读取 library 内的文件路径，必须 export 才能给 vision-tagger 处理。

## 工作流程

### 1. 确认范围（ask_user_question）
- 处理哪个相册？（列所有相册让用户选，或"全部"）
- 模式？(face / classify / all)
- 是否限定时间范围？(全部 / 最近 30 天 / 自定义)

### 2. 导出照片
- 创建临时目录 \`mktemp -d -t photo-archive\`
- AppleScript 调用 Photos.app 导出选中相册
- 列出导出后的文件清单

### 3. 批量调 vision-tagger
- 对每张导出的照片，运行 \`vision-tagger --photo <path> --mode <mode>\`
- 收集 JSON 结果

### 4. 人脸聚类（仅 face/all 模式）
- 用每张脸的 featurePrint（base64 解码后的 Float32 数组）做相似度比较
- 简单算法：cosine similarity > 0.6 视为同一人，连通分量聚类
- 给每个 cluster 起 placeholder 标签（"person-1"、"person-2"），让用户后续重命名

### 5. 主题归档（仅 classify/all 模式）
- 收集每张照片的 top 3 classifications
- 按 identifier 分组（动物、风景、食物、人物聚会等）

### 6. 入库 memories 表
- 每张照片一条 memory 记录
- type='photo_archive'
- category='face_cluster' / 'theme_tag' / 'mixed'
- summary：人脸数 + 主题标签 + 相册名
- metadata：照片原始路径 + 人脸 cluster id + 主题 identifier 列表 + Photos.app UUID（如能拿到）

### 7. 输出报告

\`\`\`markdown
# 相册归档报告：{相册名}

## 概览
- 处理照片：N 张
- 检测到人脸：M 张包含人脸（共 K 个 unique 聚类）
- 主题标签：Top 5 类别 ...

## 人物聚类

### Person-1（N 张照片）
- 占比：x%
- 代表照片：path1.jpg, path2.jpg...
- 平均置信度：0.9

### Person-2（M 张）
...

## 主题分布

| 主题 | 照片数 | Top 示例 |
|------|--------|---------|
| ... | ... | ... |

## 入库记录
共写入 N 条 memories 记录（type='photo_archive'）。
后续可用 \`memory_search\` 按主题/人物搜照片。
\`\`\`

## 注意事项

1. **隐私优先** — 人脸特征向量留在本机 memories 表，不上传任何云端
2. **导出耗时** — 大相册（>1000 张）逐张 export 慢，提示用户预估时间
3. **临时目录清理** — 跑完归档后删 export 临时目录，节省磁盘
4. **聚类阈值** — 0.6 cosine similarity 是经验值，发现错误聚类时调整
5. **人名留白** — 不主动给 cluster 起人名（隐私），让用户自己重命名 cluster id`,
    basePath: '',
    allowedTools: ['photo_archive', 'bash', 'read_file', 'write_file', 'ask_user_question', 'memory_search'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'create-role',
    description:
      '对话式创建一个新的持久化角色（专家 Agent）。通过访谈了解角色职责，起草定义，让用户确认后落地。' +
      '触发词：新建角色、招个角色、创建角色、做一个 XX 专家、create role、招新。',
    promptContent: `你现在进入「建角色」流程：通过对话帮用户创建一个新的持久化角色（专家 Agent）。
角色 = 角色定义（agents/<名字>.md）+ 角色记忆 + 工作履历，跨会话存活、归用户所有。

## 你的工作方式

你是「角色架构师」。不要让用户去填表或勾工具清单——由你访谈、起草、解释，用户只需自然语言描述和确认。

### 1. 访谈（简短，1-2 轮，不要盘问）
先问清楚关键的几点（能从用户已说的话推断就不要再问）：
- 这个角色主要干什么活？典型场景是什么？
- 需要哪些能力？（联网调研 / 读写文件 / 跑命令 / 数据处理 / 生成文档等——用大白话问，不要报工具名）
如果用户一句话已经说清楚了（如"招个帮我盯竞品动态的研究员"），直接进入起草，最多确认一个点。

### 2. 起草并调用 propose_role
把访谈结论组装成角色定义，调用 \`propose_role\` 工具：
- **roleId**：角色名（简短、可中文，如"竞品分析师"）
- **description**：一句话描述这个角色的专长
- **category**：从 docs-office/data-analysis/design-creative/content-marketing/research/automation/development 里选最贴近的
- **tools**：根据需要的能力翻译成工具白名单，取**最小够用集**。常用映射：
  - 联网调研 → WebSearch, WebFetch
  - 读写文件 → Read, Write, ListDirectory, Glob, Grep
  - 跑命令 → Bash
  - 数据/表格 → read_xlsx, excel_generate, chart_generate
  - 记忆 → MemoryRead, MemoryWrite
  - 任务编排 → TaskManager
  调用前用一句话告诉用户你给它配了哪些能力、为什么（尤其涉及 Bash/写文件这种高权限要点明）。
- **systemPrompt**：角色的系统提示词（markdown），写清专长、工作准则、输出格式。可参考预设角色的结构（核心能力 / 工作准则 / 输出格式）。

\`propose_role\` 会生成草稿并在聊天里弹出**确认卡**。草稿不会自动入库。

### 3. 迭代与确认
- 工具返回后，告诉用户："草稿好了，你可以直接点确认创建，或告诉我要改什么。"
- 用户要改（"工具太多了去掉 Bash""语气再专业点"）→ 重新调用 \`propose_role\`（同名会被去重，先让用户在卡片上放弃旧草稿，或换名）。
- **不要替用户点确认**——确认只能由用户在卡片上操作。你不要调用任何"确认/落盘"动作。
- 如果 \`propose_role\` 返回重名错误，换个名字或提示用户已有同名角色。

### 4. 用户跑题时退出流程
如果用户此轮的请求与建角色无关（比如中途让你干别的活）：先调用 \`exit_role_flow\` 退出本流程（草稿会保留在确认卡上，用户随时可回来确认），然后正常处理用户的请求。不要拒绝用户，也不要说"环境受限"。

## 红线
- 严禁自动创建：你只负责起草（propose_role），落盘由用户在确认卡上完成。
- 不要硬塞工具：最小够用，高权限工具要向用户说明。
- 访谈要短：用户烦被盘问，能推断就别问。`,
    basePath: '',
    allowedTools: ['propose_role', 'exit_role_flow', 'ask_user_question', 'read_file', 'glob', 'grep'],
    // 严格工具集：只暴露上面这些工具，隐藏 core 的 Edit/Write，逼模型走 propose_role 确认卡
    strictToolset: true,
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'create-team',
    description:
      '对话式创建一个团队配方：一句话描述需求或提供现有流程文档，提取专家分工后起草，用户确认才保存。' +
      '触发词：建配方、组个团队、创建团队、把流程变成团队、资料转配方、create team。',
    promptContent: `你现在进入「建团队配方」流程。用户可以用一句话描述要组什么团队，也可以给现成的文档、流程或提示词；你负责短访谈、提取角色分工，然后起草确认卡。

## 两条输入路径

1. 一句话建团队：只补足目的、分工和是否需要主理人这几个关键信息；能判断就不要追问。
2. 资料转化：先读用户提供的文件或正文，提取有几个角色、各自做什么、谁统筹。把资料里的具体项目或主题替换为 \`{topic}\`，再起草配方。

## 调用 propose_team_recipe

- \`lead\` 有值 = 专家团：主理人汇总成员结论并定稿。
- 省略 \`lead\` = 专家小组：成员各自独立作答，不合并。
- \`members\` 每人必须有现有本机 \`roleId\` 和含 \`{topic}\` 的 \`taskTemplate\`。
- 若资料中的岗位本机没有对应专家，绝不静默省掉；工具会返回明确名单。告诉用户可换成已有专家，或先建这个角色后再继续。
- 草稿不会自动保存。工具成功后让用户在确认卡上确认，或继续说修改意见；不得代替用户确认。

## 红线

- 不从跑过的会话反推配方；只转化用户明确提供的资料。
- 不编辑 dependsOn、分享或导出配方。
- 不自动入库。`,
    basePath: '',
    allowedTools: ['propose_team_recipe', 'ask_user_question', 'read_file', 'glob', 'grep'],
    strictToolset: false,
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'edit-role',
    description:
      '对话式修改一个已存在的持久化角色（改它的描述、工具白名单或系统提示词）。先读取现有定义，访谈要改什么，重新起草让用户确认。' +
      '触发词：修改角色、编辑角色、改一下XX角色、调整角色、edit role。注意：是改已有角色，不是新建。',
    promptContent: `你现在进入「改角色」流程：通过对话帮用户修改一个**已存在的**持久化角色。
只换角色定义（agents/<名字>.md：描述 / 工具 / 系统提示词），**绝不动**该角色已经积累的记忆和工作履历——那是用户的资产。

## 你的工作方式

你是「角色架构师」。由你读现状、访谈、起草、解释，用户只需自然语言描述要改什么并确认。

### 1. 先载入现有定义（必做）
要修改的角色名由本次调用的参数给出（消息末尾的 "User provided arguments: <角色名>"；若没有则看用户消息里点名的角色）。
先用 \`read_file\` 读它的当前定义：\`~/.code-agent/agents/<角色名>.md\`（角色名可中文，原样填，不要翻译/改写）。
读到后，简要复述它现在是什么样（描述 / 有哪些工具 / 大致职责），让用户在已知现状的基础上提改动。
如果读不到（路径不对或角色不存在），告诉用户没找到这个角色，让他确认名字。

### 2. 访谈要改什么（简短）
基于现有定义问清楚改动点：改描述？加 / 减哪些能力（工具）？调整工作准则或语气？能从用户已说的话推断就别再问。

### 3. 起草并调用 propose_role（带 editingRoleId）
把"现有定义 + 用户的改动"合并成完整的新定义，调用 \`propose_role\`，并且**必须带上 \`editingRoleId\`**：
- **editingRoleId**：等于被修改角色的名字（与 roleId 相同——本期不支持改名）
- **roleId**：保持与 editingRoleId 一致（不要改名；用户若想改名，告诉他本期暂不支持）
- **description / category / tools / systemPrompt**：合并后的完整新定义（不是只填改动的部分——是整份覆盖）
  - tools 取最小够用集，增减能力时用一句话告诉用户你动了哪些（尤其 Bash / 写文件这种高权限）
\`propose_role\` 会生成**修改草稿**并在聊天里弹出确认卡。草稿不会自动入库。

### 4. 迭代与确认
- 工具返回后告诉用户："修改草稿好了，你可以直接点确认修改，或继续告诉我要再改什么。"
- 用户要再改 → 重新调用 \`propose_role\`（仍带 editingRoleId）。
- **不要替用户点确认**——确认只能由用户在卡片上操作。

### 5. 用户跑题时退出流程
如果用户此轮的请求与改角色无关：先调用 \`exit_role_flow\` 退出本流程（修改草稿会保留在确认卡上），然后正常处理用户的请求。不要拒绝用户，也不要说"环境受限"。

## 红线
- 只改定义，绝不动角色记忆 / 履历（那是用户积累的资产，确认落盘只覆盖 agents/<名字>.md）。
- 不支持改名：editingRoleId 必须等于 roleId，想改名直接告诉用户本期不支持。
- 严禁自动落盘：你只负责读现状 + 起草（propose_role），确认由用户在卡片上完成。`,
    basePath: '',
    allowedTools: ['propose_role', 'exit_role_flow', 'read_file', 'ask_user_question', 'glob', 'grep'],
    // 严格工具集：只暴露上面这些工具，隐藏 core 的 Edit/Write，逼模型走 propose_role 确认卡
    strictToolset: true,
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  // ==========================================================================
  // 方法论 skill（roadmap 2.3）— Adapted from superpowers (obra/superpowers, MIT)
  // via MiMoCode (XiaomiMiMo/MiMo-Code, MIT) compose bundle。铁律原文保留；
  // compose:X 引用已适配为 Neo skill 名；review 更名 work-review 避免与任务型
  // review 冲突。
  // ==========================================================================
  {
    name: 'brainstorm',
    description: '创意工作前的需求探索（superpowers 方法论）',
    promptContent: `# Brainstorming Ideas Into Designs

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.

**Autonomous override:** When no user is available to approve, this HARD-GATE does not apply: skip design presentation and approval, proceed directly to implementation, treating every approval gate as auto-approved.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

**Autonomous override:** When no user is available, skip this anti-pattern guidance — proceed directly to exploring context and implementing; do not present a design for approval.

## Checklist

You MUST create a task for each of these items and complete them in order:

**Autonomous mode (no user available):** Skip steps 2–8. Only do: explore project context (step 1) → implement directly (invoke plan or execute). Do NOT present a design, ask questions, write a spec, or wait for approval.

1. **Explore project context** — check files, docs, recent commits
2. **Offer visual companion** (if topic will involve visual questions) — this is its own message, not combined with a clarifying question. See the Visual Companion section below.
3. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
4. **Propose 2-3 approaches** — with trade-offs and your recommendation
5. **Present design** — in sections scaled to their complexity, get user approval after each section
6. **Write design doc** (optional, multi-step features only) — save to \`docs/compose/specs/YYYY-MM-DD-<topic>-design.md\` and commit. For single-step fixes or small changes, keep the design in conversation context only.
7. **Spec self-review** (if doc written) — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
8. **User reviews written spec** (if doc written) — ask user to review the spec file before proceeding
9. **Transition to implementation** — invoke plan to create implementation plan

## Process Flow

\`\`\`dot
digraph brainstorm {
    "Explore project context" [shape=box];
    "Visual questions ahead?" [shape=diamond];
    "Offer Visual Companion\\n(own message, no other content)" [shape=box];
    "Ask clarifying questions" [shape=box];
    "Propose 2-3 approaches" [shape=box];
    "Present design sections" [shape=box];
    "User approves design?" [shape=diamond];
    "Write design doc" [shape=box];
    "Spec self-review\\n(fix inline)" [shape=box];
    "User reviews spec?" [shape=diamond];
    "Invoke plan" [shape=doublecircle];

    "Explore project context" -> "Visual questions ahead?";
    "Visual questions ahead?" -> "Offer Visual Companion\\n(own message, no other content)" [label="yes"];
    "Visual questions ahead?" -> "Ask clarifying questions" [label="no"];
    "Offer Visual Companion\\n(own message, no other content)" -> "Ask clarifying questions";
    "Ask clarifying questions" -> "Propose 2-3 approaches";
    "Propose 2-3 approaches" -> "Present design sections";
    "Present design sections" -> "User approves design?";
    "User approves design?" -> "Present design sections" [label="no, revise"];
    "User approves design?" -> "Write design doc" [label="yes"];
    "Write design doc" -> "Spec self-review\\n(fix inline)";
    "Spec self-review\\n(fix inline)" -> "User reviews spec?";
    "User reviews spec?" -> "Write design doc" [label="changes requested"];
    "User reviews spec?" -> "Invoke plan" [label="approved"];
}
\`\`\`

**The terminal state is invoking plan.** Do NOT invoke frontend-design, mcp-builder, or any other implementation skill. The ONLY skill you invoke after brainstorming is plan.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems (e.g., "build a platform with chat, file storage, billing, and analytics"), flag this immediately. Don't spend questions refining details of a project that needs to be decomposed first.
- If the project is too large for a single spec, help the user decompose into sub-projects: what are the independent pieces, how do they relate, what order should they be built? Then brainstorm the first sub-project through the normal design flow. Each sub-project gets its own spec → plan → implementation cycle.
- For appropriately-scoped projects, ask questions one at a time to refine the idea
- When the question has a known set of likely answers, use \`ask\` with those answers as options
- For open-ended questions, use \`ask\` with 2-3 suggested answers as options — the user can always type their own answer
- If no user is available, make reasonable assumptions from project context and proceed
- Only one question per tool call — if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- After presenting each section, use \`ask\`:
  - header: \`Design Review\`
  - question: \`Does this <section-name> look right?\`
  - options:
    - label: \`Looks good\`, description: \`Approve and continue\`
    - label: \`Needs changes\`, description: \`I have feedback\`

  If no user is available, treat as approved and continue.
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
- For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.
- Smaller, well-bounded units are also easier for you to work with - you reason better about code you can hold in context at once, and your edits are more reliable when files are focused. When a file grows large, that's often a signal that it's doing too much.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design - the way a good developer improves code they're working in.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

**Documentation (optional, multi-step features only):**

For features with multiple tasks or significant architectural decisions:
- Write the validated design (spec) to \`docs/compose/specs/YYYY-MM-DD-<topic>-design.md\`
  - (User preferences for spec location override this default)
- Use elements-of-style:writing-clearly-and-concisely skill if available
- Commit the design document to git

For single bug fixes or small changes, skip the written spec — the design presented in conversation is sufficient.

**Spec Self-Review (if doc written):**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate (if doc written):**
After spec self-review passes, use \`ask\`:
- header: \`Spec Review\`
- question: \`Spec written and committed to <path>. Ready to proceed?\`
- options:
  - label: \`Approved\`, description: \`Proceed to plan\`
  - label: \`Changes needed\`, description: \`I have revisions\`

If no user is available, treat as approved and invoke plan.

If "Changes needed" or custom feedback, apply changes and re-run spec review. Only proceed on approval.

**Implementation:**

- Invoke plan to create a detailed implementation plan
- Do NOT invoke any other skill. plan is the next step.

## Spec Section Anchors

When writing the spec, give every \`##\` section heading a stable anchor ID so downstream plan tasks and reviewers can reference exact spec locations. Put the ID at the start of the heading text:

\`\`\`markdown
## [S1] Problem
## [S2] Solution overview
## [S3] Coverage gate behavior
\`\`\`

Rules:

- **ID format** is \`S\` followed by a number (\`[S1]\`, \`[S2]\`, \`[S3]\`, ...), unique within the spec — no two sections share an ID, and no section is left without one.
- **Number sections in document order** when first authoring the spec (top section is \`[S1]\`, the next is \`[S2]\`, and so on).
- **The ID is stable.** If a heading is later reworded, keep its existing ID and do NOT renumber the other sections. Downstream \`covers:\` references and review verdicts depend on these IDs not drifting — renumbering would silently break every reference that points at them.

These anchors are the index the plan and reviewers use to trace each task and each review verdict back to the exact spec section it serves.

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design, get approval before moving on
- **Be flexible** - Go back and clarify when something doesn't make sense

## Visual Companion

A browser-based companion for showing mockups, diagrams, and visual options during brainstorming. Available as a tool — not a mode. Accepting the companion means it's available for questions that benefit from visual treatment; it does NOT mean every question goes through the browser.

**Offering the companion:** When you anticipate visual content (mockups, layouts, diagrams):

1. **Check memory** for a \`visual-companion\` preference in the \`compose-preferences\` memory file. If found, honor it.

2. **If no saved preference,** offer consent using \`ask\` (this MUST be its own message — do not combine with other content):
   - header: \`Visual Companion\`
   - question: \`Some upcoming questions may benefit from browser-based mockups and diagrams. This feature is token-intensive and requires opening a local URL.\`
   - options:
     - label: \`Yes, always\`, description: \`Enable visuals for this and future sessions\`
     - label: \`No, never\`, description: \`Skip visuals for this and future sessions\`
     - label: \`Yes, this time\`, description: \`Enable visuals for this session only\`
     - label: \`No, this time\`, description: \`Skip visuals for this session only\`

   If no user is available, skip the visual companion and use text-only.

3. **If "Yes, always" or "No, never":** Save to the \`compose-preferences\` memory file.

If declined, proceed with text-only brainstorming.

**Per-question decision:** Even after the user accepts, decide FOR EACH QUESTION whether to use the browser or the terminal. The test: **would the user understand this better by seeing it than reading it?**

- **Use the browser** for content that IS visual — mockups, wireframes, layout comparisons, architecture diagrams, side-by-side visual designs
- **Use the terminal** for content that is text — requirements questions, conceptual choices, tradeoff lists, A/B/C/D text options, scope decisions

A question about a UI topic is not automatically a visual question. "What does personality mean in this context?" is a conceptual question — use the terminal. "Which wizard layout works better?" is a visual question — use the browser.

If they agree to the companion, read the detailed guide before proceeding:
\`<brainstorm>/visual-companion.md\``,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'TaskManager', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    license: 'MIT (obra/superpowers, adapted via XiaomiMiMo/MiMo-Code)',
    metadata: { category: 'development', upstreamDescription: 'You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation.' },
  },
  {
    name: 'tdd',
    description: '测试驱动开发铁律：先写失败测试再写实现（superpowers 方法论）',
    promptContent: `# Test-Driven Development (TDD)

## Overview

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of the rules is violating the spirit of the rules.**

## When to Use

**Always:**
- New features
- Bug fixes
- Refactoring
- Behavior changes

**Exceptions (raise them through \`ask\`; if no user is available, use your best judgment and proceed):**
- Throwaway prototypes
- Generated code
- Configuration files

Thinking "skip TDD just this once"? Stop. That's rationalization.

## The Iron Law

\`\`\`
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
\`\`\`

Write code before the test? Delete it. Start over.

**No exceptions:**
- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

Implement fresh from tests. Period.

## Red-Green-Refactor

\`\`\`dot
digraph tdd_cycle {
    rankdir=LR;
    red [label="RED\\nWrite failing test", shape=box, style=filled, fillcolor="#ffcccc"];
    verify_red [label="Verify fails\\ncorrectly", shape=diamond];
    green [label="GREEN\\nMinimal code", shape=box, style=filled, fillcolor="#ccffcc"];
    verify_green [label="Verify passes\\nAll green", shape=diamond];
    refactor [label="REFACTOR\\nClean up", shape=box, style=filled, fillcolor="#ccccff"];
    next [label="Next", shape=ellipse];

    red -> verify_red;
    verify_red -> green [label="yes"];
    verify_red -> red [label="wrong\\nfailure"];
    green -> verify_green;
    verify_green -> refactor [label="yes"];
    verify_green -> green [label="no"];
    refactor -> verify_green [label="stay\\ngreen"];
    verify_green -> next;
    next -> red;
}
\`\`\`

### RED - Write Failing Test

Write one minimal test showing what should happen.

<Good>
\`\`\`typescript
test('retries failed operations 3 times', async () => {
  let attempts = 0;
  const operation = () => {
    attempts++;
    if (attempts < 3) throw new Error('fail');
    return 'success';
  };

  const result = await retryOperation(operation);

  expect(result).toBe('success');
  expect(attempts).toBe(3);
});
\`\`\`
Clear name, tests real behavior, one thing
</Good>

<Bad>
\`\`\`typescript
test('retry works', async () => {
  const mock = jest.fn()
    .mockRejectedValueOnce(new Error())
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce('success');
  await retryOperation(mock);
  expect(mock).toHaveBeenCalledTimes(3);
});
\`\`\`
Vague name, tests mock not code
</Bad>

**Requirements:**
- One behavior
- Clear name
- Real code (no mocks unless unavoidable)

### Verify RED - Watch It Fail

**MANDATORY. Never skip.**

\`\`\`bash
npm test path/to/test.test.ts
\`\`\`

Confirm:
- Test fails (not errors)
- Failure message is expected
- Fails because feature missing (not typos)

**Test passes?** You're testing existing behavior. Fix test.

**Test errors?** Fix error, re-run until it fails correctly.

### GREEN - Minimal Code

Write simplest code to pass the test.

<Good>
\`\`\`typescript
async function retryOperation<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  throw new Error('unreachable');
}
\`\`\`
Just enough to pass
</Good>

<Bad>
\`\`\`typescript
async function retryOperation<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    backoff?: 'linear' | 'exponential';
    onRetry?: (attempt: number) => void;
  }
): Promise<T> {
  // YAGNI
}
\`\`\`
Over-engineered
</Bad>

Don't add features, refactor other code, or "improve" beyond the test.

### Verify GREEN - Watch It Pass

**MANDATORY.**

\`\`\`bash
npm test path/to/test.test.ts
\`\`\`

Confirm:
- Test passes
- Other tests still pass
- Output pristine (no errors, warnings)

**Test fails?** Fix code, not test.

**Other tests fail?** Fix now.

### REFACTOR - Clean Up

After green only:
- Remove duplication
- Improve names
- Extract helpers

Keep tests green. Don't add behavior.

### Repeat

Next failing test for next feature.

## Good Tests

| Quality | Good | Bad |
|---------|------|-----|
| **Minimal** | One thing. "and" in name? Split it. | \`test('validates email and domain and whitespace')\` |
| **Clear** | Name describes behavior | \`test('test1')\` |
| **Shows intent** | Demonstrates desired API | Obscures what code should do |

## Why Order Matters

**"I'll write tests after to verify it works"**

Tests written after code pass immediately. Passing immediately proves nothing:
- Might test wrong thing
- Might test implementation, not behavior
- Might miss edge cases you forgot
- You never saw it catch the bug

Test-first forces you to see the test fail, proving it actually tests something.

**"I already manually tested all the edge cases"**

Manual testing is ad-hoc. You think you tested everything but:
- No record of what you tested
- Can't re-run when code changes
- Easy to forget cases under pressure
- "It worked when I tried it" ≠ comprehensive

Automated tests are systematic. They run the same way every time.

**"Deleting X hours of work is wasteful"**

Sunk cost fallacy. The time is already gone. Your choice now:
- Delete and rewrite with TDD (X more hours, high confidence)
- Keep it and add tests after (30 min, low confidence, likely bugs)

The "waste" is keeping code you can't trust. Working code without real tests is technical debt.

**"TDD is dogmatic, being pragmatic means adapting"**

TDD IS pragmatic:
- Finds bugs before commit (faster than debugging after)
- Prevents regressions (tests catch breaks immediately)
- Documents behavior (tests show how to use code)
- Enables refactoring (change freely, tests catch breaks)

"Pragmatic" shortcuts = debugging in production = slower.

**"Tests after achieve the same goals - it's spirit not ritual"**

No. Tests-after answer "What does this do?" Tests-first answer "What should this do?"

Tests-after are biased by your implementation. You test what you built, not what's required. You verify remembered edge cases, not discovered ones.

Tests-first force edge case discovery before implementing. Tests-after verify you remembered everything (you didn't).

30 minutes of tests after ≠ TDD. You get coverage, lose proof tests work.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Tests after achieve same goals" | Tests-after = "what does this do?" Tests-first = "what should this do?" |
| "Already manually tested" | Ad-hoc ≠ systematic. No record, can't re-run. |
| "Deleting X hours is wasteful" | Sunk cost fallacy. Keeping unverified code is technical debt. |
| "Keep as reference, write tests first" | You'll adapt it. That's testing after. Delete means delete. |
| "Need to explore first" | Fine. Throw away exploration, start with TDD. |
| "Test hard = design unclear" | Listen to test. Hard to test = hard to use. |
| "TDD will slow me down" | TDD faster than debugging. Pragmatic = test-first. |
| "Manual test faster" | Manual doesn't prove edge cases. You'll re-test every change. |
| "Existing code has no tests" | You're improving it. Add tests for existing code. |

## Red Flags - STOP and Start Over

- Code before test
- Test after implementation
- Test passes immediately
- Can't explain why test failed
- Tests added "later"
- Rationalizing "just this once"
- "I already manually tested it"
- "Tests after achieve the same purpose"
- "It's about spirit not ritual"
- "Keep as reference" or "adapt existing code"
- "Already spent X hours, deleting is wasteful"
- "TDD is dogmatic, I'm being pragmatic"
- "This is different because..."

**All of these mean: Delete code. Start over with TDD.**

## Example: Bug Fix

**Bug:** Empty email accepted

**RED**
\`\`\`typescript
test('rejects empty email', async () => {
  const result = await submitForm({ email: '' });
  expect(result.error).toBe('Email required');
});
\`\`\`

**Verify RED**
\`\`\`bash
$ npm test
FAIL: expected 'Email required', got undefined
\`\`\`

**GREEN**
\`\`\`typescript
function submitForm(data: FormData) {
  if (!data.email?.trim()) {
    return { error: 'Email required' };
  }
  // ...
}
\`\`\`

**Verify GREEN**
\`\`\`bash
$ npm test
PASS
\`\`\`

**REFACTOR**
Extract validation for multiple fields if needed.

## Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

Can't check all boxes? You skipped TDD. Start over.

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write wished-for API. Write assertion first. Ask through \`ask\`; if no user is available, use the simplest testable approach. |
| Test too complicated | Design too complicated. Simplify interface. |
| Must mock everything | Code too coupled. Use dependency injection. |
| Test setup huge | Extract helpers. Still complex? Simplify design. |

## Debugging Integration

Bug found? Write failing test reproducing it. Follow TDD cycle. Test proves fix and prevents regression.

Never fix bugs without a test.

## Testing Anti-Patterns

- Testing mock behavior instead of real behavior
- Adding test-only methods to production classes
- Mocking without understanding dependencies

## Final Rule

\`\`\`
Production code → test exists and failed first
Otherwise → not TDD
\`\`\`

No exceptions without your human partner's permission.`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'TaskManager', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    license: 'MIT (obra/superpowers, adapted via XiaomiMiMo/MiMo-Code)',
    metadata: { category: 'development', upstreamDescription: 'Use when implementing any feature or bugfix, before writing implementation code' },
  },
  {
    name: 'debug',
    description: '系统化调试四阶段：先查根因再修（superpowers 方法论）',
    promptContent: `# Systematic Debugging

## Overview

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

## The Iron Law

\`\`\`
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
\`\`\`

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue:
- Test failures
- Bugs in production
- Unexpected behavior
- Performance problems
- Build failures
- Integration issues

**Use this ESPECIALLY when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**
- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)
- Manager wants it fixed NOW (systematic is faster than thrashing)

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully**
   - Don't skip past errors or warnings
   - They often contain the exact solution
   - Read stack traces completely
   - Note line numbers, file paths, error codes

2. **Reproduce Consistently**
   - Can you trigger it reliably?
   - What are the exact steps?
   - Does it happen every time?
   - If not reproducible → gather more data, don't guess

3. **Check Recent Changes**
   - What changed that could cause this?
   - Git diff, recent commits
   - New dependencies, config changes
   - Environmental differences

4. **Gather Evidence in Multi-Component Systems**

   **WHEN system has multiple components (CI → build → signing, API → service → database):**

   **BEFORE proposing fixes, add diagnostic instrumentation:**
   \`\`\`
   For EACH component boundary:
     - Log what data enters component
     - Log what data exits component
     - Verify environment/config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze evidence to identify failing component
   THEN investigate that specific component
   \`\`\`

   **Example (multi-layer system):**
   \`\`\`bash
   # Layer 1: Workflow
   echo "=== Secrets available in workflow: ==="
   echo "IDENTITY: \${IDENTITY:+SET}\${IDENTITY:-UNSET}"

   # Layer 2: Build script
   echo "=== Env vars in build script: ==="
   env | grep IDENTITY || echo "IDENTITY not in environment"

   # Layer 3: Signing script
   echo "=== Keychain state: ==="
   security list-keychains
   security find-identity -v

   # Layer 4: Actual signing
   codesign --sign "$IDENTITY" --verbose=4 "$APP"
   \`\`\`

   **This reveals:** Which layer fails (secrets → workflow ✓, workflow → build ✗)

5. **Trace Data Flow**

   **WHEN error is deep in call stack:**

   See \`root-cause-tracing.md\` in this directory for the complete backward tracing technique.

   **Quick version:**
   - Where does bad value originate?
   - What called this with bad value?
   - Keep tracing up until you find the source
   - Fix at source, not at symptom

### Phase 2: Pattern Analysis

**Find the pattern before fixing:**

1. **Find Working Examples**
   - Locate similar working code in same codebase
   - What works that's similar to what's broken?

2. **Compare Against References**
   - If implementing pattern, read reference implementation COMPLETELY
   - Don't skim - read every line
   - Understand the pattern fully before applying

3. **Identify Differences**
   - What's different between working and broken?
   - List every difference, however small
   - Don't assume "that can't matter"

4. **Understand Dependencies**
   - What other components does this need?
   - What settings, config, environment?
   - What assumptions does it make?

### Phase 3: Hypothesis and Testing

**Scientific method:**

1. **Form Single Hypothesis**
   - State clearly: "I think X is the root cause because Y"
   - Write it down
   - Be specific, not vague

2. **Test Minimally**
   - Make the SMALLEST possible change to test hypothesis
   - One variable at a time
   - Don't fix multiple things at once

3. **Verify Before Continuing**
   - Did it work? Yes → Phase 4
   - Didn't work? Form NEW hypothesis
   - DON'T add more fixes on top

4. **When You Don't Know**
   - Say "I don't understand X"
   - Don't pretend to know
   - Ask for help through \`ask\` — present what you've tried and offer structured next-step options. If no user is available, take the most promising next step and continue.
   - Research more

### Phase 4: Implementation

**Fix the root cause, not the symptom:**

1. **Create Failing Test Case**
   - Simplest possible reproduction
   - Automated test if possible
   - One-off test script if no framework
   - MUST have before fixing
   - Use the \`tdd\` skill for writing proper failing tests

2. **Implement Single Fix**
   - Address the root cause identified
   - ONE change at a time
   - No "while I'm here" improvements
   - No bundled refactoring

3. **Verify Fix**
   - Test passes now?
   - No other tests broken?
   - Issue actually resolved?

4. **If Fix Doesn't Work**
   - STOP
   - Count: How many fixes have you tried?
   - If < 3: Return to Phase 1, re-analyze with new information
   - **If ≥ 3: STOP and question the architecture (step 5 below)**
   - DON'T attempt Fix #4 without architectural discussion

5. **If 3+ Fixes Failed: Question Architecture**

   **Pattern indicating architectural problem:**
   - Each fix reveals new shared state/coupling/problem in different place
   - Fixes require "massive refactoring" to implement
   - Each fix creates new symptoms elsewhere

   **STOP and question fundamentals:**
   - Is this pattern fundamentally sound?
   - Are we "sticking with it through sheer inertia"?
   - Should we refactor architecture vs. continue fixing symptoms?

   **Use \`ask\` to present the architectural concern** with options like "Continue fixing" / "Propose refactor" / "Discuss first". If no user is available, choose "Propose refactor" and proceed.

   This is NOT a failed hypothesis - this is a wrong architecture.

## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" (when already tried 2+)**
- **Each fix reveals new problem in different place**

**ALL of these mean: STOP. Return to Phase 1.**

**If 3+ fixes failed:** Question the architecture (see Phase 4.5)

## your human partner's Signals You're Doing It Wrong

**Watch for these redirections:**
- "Is that not happening?" - You assumed without verifying
- "Will it show us...?" - You should have added evidence gathering
- "Stop guessing" - You're proposing fixes without understanding
- "Ultrathink this" - Question fundamentals, not just symptoms
- "We're stuck?" (frustrated) - Your approach isn't working

**When you see these:** STOP. Return to Phase 1.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll write test after confirming fix works" | Untested fixes don't stick. Test first proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question pattern, don't fix again. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix, verify | Bug resolved, tests pass |

## When Process Reveals "No Root Cause"

If systematic investigation reveals issue is truly environmental, timing-dependent, or external:

1. You've completed the process
2. Document what you investigated
3. Implement appropriate handling (retry, timeout, error message)
4. Add monitoring/logging for future investigation

**But:** 95% of "no root cause" cases are incomplete investigation.

## Supporting Techniques

These techniques are part of systematic debugging and available in this directory:

- **\`root-cause-tracing.md\`** - Trace bugs backward through call stack to find original trigger
- **\`defense-in-depth.md\`** - Add validation at multiple layers after finding root cause
- **\`condition-based-waiting.md\`** - Replace arbitrary timeouts with condition polling

**Related skills:**
- **tdd** - For creating failing test case (Phase 4, Step 1)
- **verify** - Verify fix worked before claiming success

## Real-World Impact

From debugging sessions:
- Systematic approach: 15-30 minutes to fix
- Random fixes approach: 2-3 hours of thrashing
- First-time fix rate: 95% vs 40%
- New bugs introduced: Near zero vs common`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'TaskManager', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    license: 'MIT (obra/superpowers, adapted via XiaomiMiMo/MiMo-Code)',
    metadata: { category: 'development', upstreamDescription: 'Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes' },
  },
  {
    name: 'verify',
    description: '完成声明前先跑验证拿证据（superpowers 方法论）',
    promptContent: `# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

\`\`\`
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
\`\`\`

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

\`\`\`
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
\`\`\`

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
\`\`\`
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
\`\`\`

**Regression tests (TDD Red-Green):**
\`\`\`
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
\`\`\`

**Build:**
\`\`\`
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
\`\`\`

**Requirements:**
\`\`\`
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
\`\`\`

**Agent delegation:**
\`\`\`
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
\`\`\`

## Why This Matters

From 24 failure memories:
- your human partner said "I don't believe you" - trust broken
- Undefined functions shipped - would crash
- Missing requirements shipped - incomplete features
- Time wasted on false completion → redirect → rework
- Violates: "Honesty is a core value. If you lie, you'll be replaced."

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'TaskManager', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    license: 'MIT (obra/superpowers, adapted via XiaomiMiMo/MiMo-Code)',
    metadata: { category: 'development', upstreamDescription: 'Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always' },
  },
  {
    name: 'merge',
    description: '实现完成后的集成决策：merge/PR/清理（superpowers 方法论）',
    promptContent: `# Finishing a Development Branch

## Overview

Guide completion of development work by presenting clear options and handling chosen workflow.

**Core principle:** Verify tests → Detect environment → Present options → Execute choice → Clean up.

**Announce at start:** "I'm using the merge skill to complete this work."

## The Process

### Step 1: Verify Tests

**Before presenting options, verify tests pass:**

\`\`\`bash
# Run project's test suite
npm test / cargo test / pytest / go test ./...
\`\`\`

**If tests fail:**
\`\`\`
Tests failing (<N> failures). Must fix before completing:

[Show failures]

Cannot proceed with merge/PR until tests pass.
\`\`\`

Stop. Don't proceed to Step 2.

**If tests pass:** Continue to Step 2.

### Step 2: Detect Environment

**Determine workspace state before presenting options:**

\`\`\`bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
\`\`\`

This determines which menu to show and how cleanup works:

| State | Menu | Cleanup |
|-------|------|---------|
| \`GIT_DIR == GIT_COMMON\` (normal repo) | Standard 4 options | No worktree to clean up |
| \`GIT_DIR != GIT_COMMON\`, named branch | Standard 4 options | Provenance-based (see Step 6) |
| \`GIT_DIR != GIT_COMMON\`, detached HEAD | Reduced 3 options (no merge) | No cleanup (externally managed) |

### Step 3: Determine Base Branch

\`\`\`bash
# Try common base branches
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
\`\`\`

If the base branch is ambiguous, confirm through \`ask\`:
- header: \`Base Branch\`
- question: \`This branch appears to have split from <detected>. Correct?\`
- options:
  - label: \`Yes, <detected>\`, description: \`Use <detected> as merge target\`
  - label: \`Different branch\`, description: \`I'll specify the correct base branch\`

If no user is available, use the detected base branch and proceed.

### Step 4: Present Options

**Normal repo / named-branch worktree — use \`ask\`:**
- header: \`Complete Work\`
- question: \`Implementation complete. What would you like to do?\`
- options:
  - label: \`Merge locally\`, description: \`Merge back to <base-branch>\`
  - label: \`Create PR\`, description: \`Push branch and open a Pull Request\`
  - label: \`Keep as-is\`, description: \`Leave the branch — I'll handle it later\`
  - label: \`Discard\`, description: \`Delete branch and all commits\`

If no user is available, merge locally and proceed.

**Detached HEAD — use \`ask\`:**
- header: \`Complete Work\`
- question: \`Implementation complete (detached HEAD, externally managed). What would you like to do?\`
- options:
  - label: \`Create PR\`, description: \`Push as new branch and open a PR\`
  - label: \`Keep as-is\`, description: \`Leave as-is — I'll handle it later\`
  - label: \`Discard\`, description: \`Delete this work permanently\`

If no user is available, create a PR and proceed.

### Step 5: Execute Choice

#### Option 1: Merge Locally

\`\`\`bash
# Get main repo root for CWD safety
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"

# Merge first — verify success before removing anything
git checkout <base-branch>
git pull
git merge <feature-branch>

# Verify tests on merged result
<test command>

# Only after merge succeeds: cleanup worktree (Step 6), then delete branch
\`\`\`

Then: Cleanup worktree (Step 6), then delete branch:

\`\`\`bash
git branch -d <feature-branch>
\`\`\`

#### Option 2: Push and Create PR

\`\`\`bash
# Push branch
git push -u origin <feature-branch>

# Create PR
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<2-3 bullets of what changed>

## Test Plan
- [ ] <verification steps>
EOF
)"
\`\`\`

**Do NOT clean up worktree** — user needs it alive to iterate on PR feedback.

#### Option 3: Keep As-Is

Report: "Keeping branch <name>. Worktree preserved at <path>."

**Don't cleanup worktree.**

#### Option 4: Discard

**Confirm through \`ask\`:**
- header: \`Confirm Discard\`
- question: \`This will permanently delete branch <name>, all commits, and worktree at <path>. Are you sure?\`
- options:
  - label: \`Cancel\`, description: \`Keep branch and worktree intact\`
  - label: \`Discard permanently\`, description: \`Cannot be undone\`

If no user is available, do NOT discard — keep the branch as-is. (Destructive actions never auto-approve; see \`ask\`.)

Only proceed if user selected "Discard permanently". If "Cancel", return to Step 4.

If confirmed:
\`\`\`bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"
\`\`\`

Then: Cleanup worktree (Step 6), then force-delete branch:
\`\`\`bash
git branch -D <feature-branch>
\`\`\`

### Step 6: Cleanup Workspace

**Only runs for Options 1 and 4.** Options 2 and 3 always preserve the worktree.

\`\`\`bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
WORKTREE_PATH=$(git rev-parse --show-toplevel)
\`\`\`

**If \`GIT_DIR == GIT_COMMON\`:** Normal repo, no worktree to clean up. Done.

**If worktree path is under \`.worktrees/\`, \`worktrees/\`, or \`~/.config/compose/worktrees/\`:** Compose created this worktree — we own cleanup.

\`\`\`bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"
git worktree remove "$WORKTREE_PATH"
git worktree prune  # Self-healing: clean up any stale registrations
\`\`\`

**Otherwise:** The host environment (harness) owns this workspace. Do NOT remove it. If your platform provides a workspace-exit tool, use it. Otherwise, leave the workspace in place.

## Quick Reference

| Option | Merge | Push | Keep Worktree | Cleanup Branch |
|--------|-------|------|---------------|----------------|
| 1. Merge locally | yes | - | - | yes |
| 2. Create PR | - | yes | yes | - |
| 3. Keep as-is | - | - | yes | - |
| 4. Discard | - | - | - | yes (force) |

## Common Mistakes

**Skipping test verification**
- **Problem:** Merge broken code, create failing PR
- **Fix:** Always verify tests before offering options

**Open-ended questions**
- **Problem:** "What should I do next?" is ambiguous
- **Fix:** Present exactly 4 structured options (or 3 for detached HEAD)

**Cleaning up worktree for Option 2**
- **Problem:** Remove worktree user needs for PR iteration
- **Fix:** Only cleanup for Options 1 and 4

**Deleting branch before removing worktree**
- **Problem:** \`git branch -d\` fails because worktree still references the branch
- **Fix:** Merge first, remove worktree, then delete branch

**Running git worktree remove from inside the worktree**
- **Problem:** Command fails silently when CWD is inside the worktree being removed
- **Fix:** Always \`cd\` to main repo root before \`git worktree remove\`

**Cleaning up harness-owned worktrees**
- **Problem:** Removing a worktree the harness created causes phantom state
- **Fix:** Only clean up worktrees under \`.worktrees/\`, \`worktrees/\`, or \`~/.config/compose/worktrees/\`

**No confirmation for discard**
- **Problem:** Accidentally delete work
- **Fix:** Require typed "discard" confirmation

## Red Flags

**Never:**
- Proceed with failing tests
- Merge without verifying tests on result
- Delete work without confirmation
- Force-push without explicit request
- Remove a worktree before confirming merge success
- Clean up worktrees you didn't create (provenance check)
- Run \`git worktree remove\` from inside the worktree

**Always:**
- Verify tests before offering options
- Detect environment before presenting menu
- Present exactly 4 options (or 3 for detached HEAD)
- Get typed confirmation for Option 4
- Clean up worktree for Options 1 & 4 only
- \`cd\` to main repo root before worktree removal
- Run \`git worktree prune\` after removal`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'TaskManager', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    license: 'MIT (obra/superpowers, adapted via XiaomiMiMo/MiMo-Code)',
    metadata: { category: 'development', upstreamDescription: 'Use when implementation is complete, all tests pass, and you need to decide how to integrate the work - guides completion of development work by presenting structured options for merge, PR, or cleanup' },
  },
  {
    name: 'work-review',
    description: '任务完成度审查：对照需求逐项核验（superpowers 方法论，区别于任务型 review）',
    promptContent: `# Requesting Code Review

Dispatch a code reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history. This keeps the reviewer focused on the work product, not your thought process, and preserves your own context for continued work.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

**1. Get git SHAs:**
\`\`\`bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
\`\`\`

**2. Dispatch code reviewer subagent:**

Use the \`actor\` tool to dispatch a \`general\` subagent (follow that tool's own description for the call syntax), building its prompt from the \`code-reviewer.md\` template

**Placeholders:**
- \`{DESCRIPTION}\` - Brief summary of what you built
- \`{PLAN_OR_REQUIREMENTS}\` - What it should do
- \`{BASE_SHA}\` - Starting commit
- \`{HEAD_SHA}\` - Ending commit

**3. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

\`\`\`
[Just completed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch code reviewer subagent]
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types
  PLAN_OR_REQUIREMENTS: Task 2 from docs/compose/plans/deployment-plan.md
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
\`\`\`

## Integration with Workflows

**Subagent-Driven Development:**
- Review after EACH task
- Catch issues before they compound
- Fix before moving to next task

**Executing Plans:**
- Review after each task or at natural checkpoints
- Get feedback, apply, continue

**Ad-Hoc Development:**
- Review before merge
- Review when stuck

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: \`<work-review>/code-reviewer.md\``,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'TaskManager', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    license: 'MIT (obra/superpowers, adapted via XiaomiMiMo/MiMo-Code)',
    metadata: { category: 'development', upstreamDescription: 'Use when completing tasks, implementing major features, or before merging to verify work meets requirements' },
  },
  // E1 内置专家包 skill（牧之/溯真/青禾/明镜，按包拆文件防单文件超债门）
  ...ROLE_PACK_SKILLS,
];

// ----------------------------------------------------------------------------
// 内置 Skill 产物分类（P2-2：与技能包/角色共用 7 类 SkillCategory）
// ----------------------------------------------------------------------------
//
// 单一真理源：分类写在这里（skill 自带分类），renderer 的"已安装"页据此把内置组
// 二次分组成产物分类。与 skillCatalog.ts 的 RECOMMENDED_SKILLS（安装推荐层）解耦——
// 这里覆盖全部内置 skill（含未进推荐目录的 dev 类 commit/review/test/...）。
// 新增内置 skill 时在此补一行；缺映射的 skill 前端归入"其他"。
const BUILTIN_SKILL_CATEGORY: Record<string, SkillCategory> = {
  // 开发工程
  commit: 'development',
  review: 'development',
  test: 'development',
  explain: 'development',
  refactor: 'development',
  docker: 'development',
  dream: 'development',
  distill: 'development',
  'task-brief-builder': 'automation',
  'research-brief-and-split': 'research',
  'implementation-closure': 'development',
  'reviewer-facing-delivery': 'docs-office',
  // 数据分析
  'data-cleaning': 'data-analysis',
  'data-analysis-helper': 'data-analysis',
  // 文档办公
  xlsx: 'docs-office',
  'meeting-summary': 'docs-office',
  // 研究调研
  'literature-review': 'research',
  'paper-distillation': 'research',
  'research-monitor': 'research',
  'opencli-search': 'research',
  // 效率自动化
  'computer-housekeeper': 'automation',
  'contract-review': 'automation',
  'image-ocr-search': 'automation',
  'photo-archive': 'automation',
  'create-role': 'automation',
  'edit-role': 'automation',
  // E1 内置专家包（分类随包数据文件维护）
  ...ROLE_PACK_SKILL_CATEGORY,
};

// 一次性把分类回填到 metadata.category（idempotent；所有 getter 共享同一引用）
for (const skill of BUILTIN_SKILLS) {
  const category = BUILTIN_SKILL_CATEGORY[skill.name];
  if (category) {
    skill.metadata = { ...skill.metadata, category };
  }
}
