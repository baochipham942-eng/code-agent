// ============================================================================
// Built-in Skills - 内置 Skill 定义
// ============================================================================

import type { ParsedSkill } from '../../../shared/contract/agentSkill';

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
