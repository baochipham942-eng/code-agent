# Code Agent 能力测试题目集

> 来源：GAIA、AgentBench、OSWorld、MultiAgentBench、ChatDev/MetaGPT
> 用途：测试 Agent 系统能力（工具调用、环境交互、多步执行、错误恢复、多 Agent 协作）

## 已实现的测试用例 (21 题)

### T2-A: 信息检索 (Web)
| 文件 | ID | 名称 | 难度 |
|------|-----|------|------|
| `AB-WEB-01-data-fetch.ts` | AB-WEB-01 | 获取 GitHub API 仓库信息 | L2 |
| `AB-WEB-02-search-analyze.ts` | AB-WEB-02 | 搜索并分析技术趋势 | L2 |
| `AB-WEB-03-multi-source.ts` | AB-WEB-03 | 多源信息整合分析 | L3 |

### T2-B: 操作系统交互 (OS)
| 文件 | ID | 名称 | 难度 |
|------|-----|------|------|
| `AB-OS-01-user-count.ts` | AB-OS-01 | 统计非 home 目录用户数 | L2 |
| `AB-OS-02-chmod-recursive.ts` | AB-OS-02 | 递归设置文件只读 | L2 |
| `AB-OS-03-find-compress.ts` | AB-OS-03 | 查找并压缩大文件 | L2 |

### T2-C: 数据库操作 (DB)
| 文件 | ID | 名称 | 难度 |
|------|-----|------|------|
| `AB-DB-01-top-salary.ts` | AB-DB-01 | 查询部门薪资 TOP3 | L2 |
| `AB-DB-02-high-value-customers.ts` | AB-DB-02 | 高价值客户分析 | L2 |
| `AB-DB-03-growth-rate.ts` | AB-DB-03 | 季度环比增长率分析 | L3 |

### T2-D: GUI/浏览器操作 (GUI)
| 文件 | ID | 名称 | 难度 |
|------|-----|------|------|
| `AB-GUI-01-screenshot-analyze.ts` | AB-GUI-01 | 截图 UI 元素分析 | L2 |
| `AB-GUI-02-browser-navigation.ts` | AB-GUI-02 | 浏览器导航与数据提取 | L3 |
| `AB-GUI-03-form-interaction.ts` | AB-GUI-03 | 浏览器表单交互测试 | L3 |

### T3-A: 软件开发协作 (CD)
| 文件 | ID | 名称 | 难度 |
|------|-----|------|------|
| `CD-01-todo-cli.ts` | CD-01 | 命令行待办事项工具 | L3 |
| `CD-02-markdown-converter.ts` | CD-02 | Markdown 到 HTML 转换器 | L3 |
| `CD-03-file-sync.ts` | CD-03 | 文件同步工具 | L3 |

### T3-B/C: 多 Agent 协作 (MAB)
| 文件 | ID | 名称 | 难度 |
|------|-----|------|------|
| `MAB-C01-pair-programming.ts` | MAB-C01 | 结对编程：排序算法 | L2 |
| `MAB-C02-bug-hunt.ts` | MAB-C02 | 协作调试：修复多个 Bug | L3 |
| `MAB-R01-research-proposal.ts` | MAB-R01 | 协作撰写研究提案 | L3 |

### 混合场景 (HYB)
| 文件 | ID | 名称 | 难度 |
|------|-----|------|------|
| `HYB-01-github-issue-fix.ts` | HYB-01 | GitHub Issue 修复流程 | L3 |
| `HYB-02-api-sdk-generator.ts` | HYB-02 | API SDK 生成器 | L3 |
| `HYB-03-codebase-analysis.ts` | HYB-03 | 代码库分析与文档生成 | L3 |

### 使用方法

```typescript
// 导入所有用例
import { agentBenchmarkCases } from './test-cases/agent-benchmark';

// 导入快速验证集（12 题）
import { quickValidationCases } from './test-cases/agent-benchmark';

// 按类别导入
import { casesByCategory } from './test-cases/agent-benchmark';
const webCases = casesByCategory.web;       // 信息检索
const osCases = casesByCategory.os;          // 操作系统
const dbCases = casesByCategory.database;    // 数据库
const guiCases = casesByCategory.gui;        // GUI/浏览器
const cdCases = casesByCategory.collaboration; // 软件协作
const mabCases = casesByCategory.multiAgent; // 多 Agent
const hybCases = casesByCategory.hybrid;     // 混合场景
```

### 命令行运行

```bash
# 运行所有用例
npx tsx src/index.ts run -t agent-benchmark -f console --verbose

# 按类别运行
npx tsx src/index.ts run -i AB-WEB-01 AB-WEB-02 AB-WEB-03 -f console  # 信息检索
npx tsx src/index.ts run -i AB-GUI-01 AB-GUI-02 AB-GUI-03 -f console  # GUI/浏览器

# 快速验证（12 题）
npx tsx src/index.ts run -i AB-WEB-01 AB-WEB-02 AB-OS-01 AB-OS-02 AB-DB-01 AB-DB-02 AB-GUI-01 CD-01 CD-02 MAB-C01 MAB-R01 HYB-01 -f console
```

---

## 一、单 Agent 能力测试

### T2-A: 信息检索与推理 (GAIA Level 2)

需要 web_search + 多步推理，5-10 步完成。

| ID | 题目 | 所需能力 | 难度 |
|----|------|---------|------|
| G2-01 | According to https://www.bls.gov/cps/, what was the difference in unemployment (in %) in the US in June 2009 between 20 years and over men and 20 years and over women? | web_fetch, 数据提取, 计算 | ⭐⭐ |
| G2-02 | According to github, when was Regression added to the oldest closed numpy.polynomial issue that has the Regression label in MM/DD/YY? | web_search, GitHub API, 时间排序 | ⭐⭐ |
| G2-03 | The Metropolitan Museum of Art has a portrait in its collection with accession number 29.100.5. Of the consecrators and co-consecrators of this portrait's subject as a bishop, what is the name of the one who never became pope? | web_search, 多跳推理 | ⭐⭐⭐ |
| G2-04 | What was the actual enrollment count of the clinical trial on H. pylori in acne vulgaris patients from Jan-May 2018 as listed on the NIH website? | web_fetch (clinicaltrials.gov), 数据定位 | ⭐⭐ |
| G2-05 | A paper about AI regulation that was originally submitted to arXiv.org in June 2022 shows a figure with three axes. Which of these axis label words is used to describe a type of society in a Physics and Society article submitted to arXiv.org on August 11, 2016? | web_search, PDF 分析, 交叉验证 | ⭐⭐⭐ |

### T2-B: 操作系统交互 (AgentBench OS)

需要 bash 执行、文件操作、状态判断。

| ID | 题目 | 所需能力 | 难度 |
|----|------|---------|------|
| AB-OS-01 | Find the number of users with non-/home directories in an OS | bash (cat /etc/passwd), 数据解析 | ⭐⭐ |
| AB-OS-02 | Recursively set all directory files to read-only, excluding your own user directory | bash (chmod, find), 条件过滤 | ⭐⭐ |
| AB-OS-03 | Find all files larger than 100MB modified in the last 7 days and compress them into a single archive | bash (find, tar), 多步组合 | ⭐⭐ |
| AB-OS-04 | Set up a cron job that backs up /var/log to /backup every day at 3am, keeping only the last 7 backups | bash (crontab, 脚本编写), 持久化配置 | ⭐⭐⭐ |
| AB-OS-05 | Find all processes consuming more than 50% CPU and log their details to a file, then kill any that have been running for more than 1 hour | bash (ps, awk, kill), 条件判断 | ⭐⭐⭐ |

### T2-C: 数据库操作 (AgentBench DB)

需要 SQL 生成、多表关联、复杂查询。

| ID | 题目 | 所需能力 | 难度 |
|----|------|---------|------|
| AB-DB-01 | 在 employees 数据库中，找出每个部门薪资最高的前 3 名员工，列出姓名、部门和薪资 | SQL (窗口函数, JOIN) | ⭐⭐ |
| AB-DB-02 | 找出过去 30 天内下单金额超过平均值 2 倍的客户，以及他们最常购买的产品类别 | SQL (子查询, GROUP BY, 聚合) | ⭐⭐ |
| AB-DB-03 | 分析 sales 表，计算每个季度的环比增长率，标记增长率下降的季度 | SQL (LAG, 日期函数, CASE) | ⭐⭐⭐ |
| AB-DB-04 | 设计一个查询检测数据库中可能的重复客户记录（基于姓名相似度和地址匹配） | SQL (模糊匹配, SOUNDEX) | ⭐⭐⭐ |
| AB-DB-05 | 在电商数据库中，找出"购买了商品 A 的客户中，有多少比例也购买了商品 B"的关联分析 | SQL (自连接, 比例计算) | ⭐⭐⭐ |

### T2-D: GUI 桌面操作 (OSWorld)

需要视觉理解 + 鼠标键盘操作。

| ID | 题目 | 所需能力 | 难度 |
|----|------|---------|------|
| OSW-01 | [LibreOffice Impress] Make a duplicate of the last two slides for me, please. | GUI 识别, 菜单操作 | ⭐⭐ |
| OSW-02 | [LibreOffice Writer] Change the text color in the textboxes on slide 1 to yellow, red, and green, respectively, in top-to-bottom order. Use exactly these colors. | GUI 精确操作, 颜色选择 | ⭐⭐ |
| OSW-03 | [GIMP] Fill the background layer with green color, leaving the object layer as is. | 图层理解, 工具使用 | ⭐⭐ |
| OSW-04 | [LibreOffice Calc + Writer] Extract the results of GPT-4 from ~/Documents/expe-results.xlsx and insert a table into the 'Main Results' section of my report. | 跨应用数据迁移 | ⭐⭐⭐ |
| OSW-05 | [Chrome + LibreOffice] Search for "2024 AI benchmark results", download the first PDF result, extract the performance table, and add it to my spreadsheet. | 多应用工作流 | ⭐⭐⭐ |

---

## 二、知识图谱与推理 (AgentBench KG)

需要 SPARQL 或 API 调用，处理大规模知识库。

| ID | 题目 | 所需能力 | 难度 |
|----|------|---------|------|
| AB-KG-01 | In Freebase, find all actors who have appeared in movies directed by both Christopher Nolan and Denis Villeneuve | SPARQL, 多条件交集 | ⭐⭐ |
| AB-KG-02 | Find the shortest path of relationships between "Albert Einstein" and "Marie Curie" in the knowledge graph | 图遍历, 路径搜索 | ⭐⭐⭐ |
| AB-KG-03 | List all Nobel Prize winners in Physics who were born in the same city as at least one Nobel Prize winner in Chemistry | SPARQL, 地理实体匹配 | ⭐⭐⭐ |

---

## 三、多 Agent 协作测试 (T3)

### T3-A: 软件开发协作 (ChatDev/MetaGPT 风格)

测试 Agent 角色分工和协作流水线。

| ID | 任务描述 | 参与角色 | 协作模式 | 难度 |
|----|---------|---------|---------|------|
| CD-01 | 开发一个命令行待办事项管理工具，支持添加、删除、列出、标记完成 | architect → coder → tester | 流水线 | ⭐⭐ |
| CD-02 | 开发一个简单的 Markdown 到 HTML 转换器，支持标题、列表、代码块 | architect → coder → reviewer → tester | 流水线 | ⭐⭐ |
| CD-03 | 开发一个文件同步工具，检测两个目录的差异并同步 | architect → coder → tester → documenter | 流水线 | ⭐⭐⭐ |
| CD-04 | 开发一个简单的 REST API 服务器，支持 CRUD 操作和 JSON 存储 | architect → coder → reviewer → tester → documenter | 流水线 | ⭐⭐⭐ |
| CD-05 | 开发一个代码质量检查工具，分析 Python 文件的复杂度和潜在问题 | plan → coder → reviewer → refactorer → tester | 流水线 | ⭐⭐⭐⭐ |

### T3-B: 研究协作 (MultiAgentBench)

测试多 Agent 讨论和共识达成。

| ID | 任务描述 | 协作模式 | 评估指标 | 难度 |
|----|---------|---------|---------|------|
| MAB-R01 | 3 个 Agent 协作撰写一份关于 "LLM Agent 安全性" 的研究提案，包含背景、方法、预期结果 | Group Discussion | 完成度 + 一致性 | ⭐⭐⭐ |
| MAB-R02 | 4 个 Agent 分析一篇技术论文，各自提出优缺点，最后达成综合评价 | Star Topology | 共识得分 | ⭐⭐⭐ |
| MAB-R03 | 多个 Agent 协作完成一个数据分析任务：一个负责数据清洗，一个负责可视化，一个负责报告撰写 | Chain Topology | 任务里程碑 | ⭐⭐⭐ |

### T3-C: 编程协作 (MultiAgentBench)

测试代码级别的多 Agent 协作。

| ID | 任务描述 | 协作模式 | 评估指标 | 难度 |
|----|---------|---------|---------|------|
| MAB-C01 | 2 个 Agent 协作实现一个排序算法：一个写代码，一个写测试用例，迭代直到测试通过 | Pair Programming | 测试通过率 | ⭐⭐ |
| MAB-C02 | 3 个 Agent 协作调试一个有 3 个 bug 的程序：分工定位和修复不同类型的 bug | Task Distribution | Bug 修复数 | ⭐⭐⭐ |
| MAB-C03 | 4 个 Agent 协作重构一个遗留代码库：分析依赖、设计新结构、迁移代码、验证功能 | Hierarchical | 重构完成度 | ⭐⭐⭐⭐ |

### T3-D: 竞争博弈 (MultiAgentBench)

测试策略推理和对抗能力。

| ID | 任务描述 | 场景 | 评估指标 | 难度 |
|----|---------|------|---------|------|
| MAB-W01 | 6 个 Agent 玩狼人杀：4 村民 vs 2 狼人，测试欺骗检测和信息推理 | Werewolf | 胜率 + 推理质量 | ⭐⭐⭐ |
| MAB-W02 | 狼人杀进阶：加入预言家和女巫角色，测试特殊信息的利用 | Werewolf+ | 角色执行度 | ⭐⭐⭐⭐ |
| MAB-B01 | 2 个 Agent 进行资源谈判：100 单位资源分配，各自有不同的效用函数 | Bargaining | 纳什均衡接近度 | ⭐⭐⭐ |
| MAB-B02 | 3 方谈判：模拟商业合作，每方有公开目标和隐藏底线 | Multi-party Negotiation | 帕累托效率 | ⭐⭐⭐⭐ |

---

## 四、综合工作流测试

### T2+T3 混合场景

| ID | 任务描述 | 涉及能力 | 难度 |
|----|---------|---------|------|
| HYB-01 | 从 GitHub 上找到一个有 bug 的开源项目 issue，分析问题，提出修复方案，生成 patch | web_search + code_analysis + edit | ⭐⭐⭐ |
| HYB-02 | 给定一个 API 文档 URL，自动生成该 API 的 Python SDK wrapper，包含类型注解和测试 | web_fetch + code_generation + testing | ⭐⭐⭐ |
| HYB-03 | 分析当前目录的代码库，生成架构文档，包含模块依赖图和关键类说明 | glob + read + analysis + write | ⭐⭐⭐ |
| HYB-04 | 多 Agent 协作：一个搜索相关论文，一个总结关键技术，一个生成实现代码 | web_search + summarize + code | ⭐⭐⭐⭐ |

---

## 五、评估指标

### 单 Agent 指标

| 指标 | 说明 |
|------|------|
| Success Rate (SR) | 任务完成率 |
| Step Efficiency | 相对于最优步数的效率 |
| Tool Accuracy | 工具调用正确率 |
| Recovery Rate | 错误恢复成功率 |

### 多 Agent 指标

| 指标 | 说明 |
|------|------|
| Task Completion | 任务完成度（里程碑 KPI） |
| Communication Score | 通信质量得分 |
| Planning Score | 规划质量得分 |
| Coordination Score | 综合协调得分 = avg(Comm, Plan) |

---

## 六、使用建议

### 快速验证（10 题）
```
G2-01, G2-04           # 信息检索
AB-OS-01, AB-OS-02     # 系统操作
AB-DB-01, AB-DB-02     # 数据库
CD-01, CD-02           # 软件开发协作
MAB-C01, MAB-R01       # 多 Agent 协作
```

### 完整测试（30 题）
按难度递进：
1. ⭐⭐ 级别：8 题
2. ⭐⭐⭐ 级别：15 题
3. ⭐⭐⭐⭐ 级别：7 题

### 专项测试
- **工具调用能力**：T2-A + T2-B
- **多步推理能力**：T2-C + T2-D
- **协作能力**：T3-A + T3-B
- **竞争/博弈能力**：T3-D

---

## 参考来源

- [GAIA Benchmark](https://huggingface.co/datasets/gaia-benchmark/GAIA)
- [AgentBench](https://github.com/THUDM/AgentBench)
- [OSWorld](https://github.com/xlang-ai/OSWorld)
- [MultiAgentBench/MARBLE](https://github.com/MultiagentBench/MARBLE)
- [ChatDev](https://github.com/OpenBMB/ChatDev)
- [MetaGPT](https://github.com/geekan/MetaGPT)
