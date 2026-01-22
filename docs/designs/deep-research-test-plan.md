# Deep Research Mode 测试计划

## 概述

本测试计划用于验证 DeerFlow 深度研究模式的集成是否正常工作。测试分为：
- **单元测试**：组件级别验证
- **集成测试**：端到端流程验证
- **UI 测试**：前端交互验证

## 测试环境准备

### 前置条件
1. DeepSeek API Key 已配置（用于计划生成和报告生成）
2. 网络搜索工具可用（需要 Firecrawl/Brave Search API）
3. 应用已构建并可运行

### 启动命令
```bash
npm run dev
```

---

## 一、前端 UI 测试

### 1.1 模式切换组件

**测试位置**: ChatInput 左侧工具栏

| # | 测试项 | 操作步骤 | 预期结果 |
|---|--------|----------|----------|
| 1 | 默认模式 | 启动应用，观察聊天输入区域 | 默认为"正常模式"，无深度研究标识 |
| 2 | 切换到深度研究 | 点击 ModeSwitch 组件，选择"深度研究" | 模式切换为 deep-research，UI 显示研究模式标识 |
| 3 | 切换回正常模式 | 再次点击 ModeSwitch，选择"正常模式" | 模式恢复为 normal |
| 4 | 报告风格选择 | 切换到深度研究模式后 | 出现报告风格选择器（6种风格） |

### 1.2 报告风格选择器

**测试位置**: 深度研究模式激活后出现

| # | 测试项 | 操作步骤 | 预期结果 |
|---|--------|----------|----------|
| 1 | 默认风格 | 切换到深度研究模式 | 默认选中"通用报告"(default) |
| 2 | 学术论文风格 | 选择"学术论文" | reportStyle 变为 academic |
| 3 | 科普文章风格 | 选择"科普文章" | reportStyle 变为 popular_science |
| 4 | 新闻报道风格 | 选择"新闻报道" | reportStyle 变为 news |
| 5 | 社交媒体风格 | 选择"社交媒体" | reportStyle 变为 social_media |
| 6 | 投资分析风格 | 选择"投资分析" | reportStyle 变为 strategic_investment |

### 1.3 研究进度显示

**测试位置**: ResearchProgress 组件

| # | 测试项 | 操作步骤 | 预期结果 |
|---|--------|----------|----------|
| 1 | 进度条初始化 | 发送深度研究请求 | 显示进度组件，初始进度 0% |
| 2 | Planning 阶段 | 观察研究开始 | 显示"正在制定研究计划..."，进度 5-15% |
| 3 | Researching 阶段 | 计划生成后 | 显示执行中的步骤标题，进度 20-75% |
| 4 | Reporting 阶段 | 研究步骤完成后 | 显示"正在生成研究报告..."，进度 80-95% |
| 5 | 完成状态 | 报告生成完成 | 进度 100%，进度条消失，显示报告 |

---

## 二、后端流程测试

### 2.1 ResearchPlanner 测试

**测试文件**: `src/main/research/researchPlanner.ts`

| # | 测试项 | 输入 | 预期输出 |
|---|--------|------|----------|
| 1 | 基础计划生成 | topic: "人工智能发展趋势" | 返回包含 research 和 analysis 步骤的计划 |
| 2 | 确保有搜索步骤 | 任意主题 | 至少有一个 stepType: 'research' 的步骤 |
| 3 | 搜索关键词生成 | topic: "量子计算" | research 步骤包含相关搜索词 |
| 4 | JSON 解析容错 | LLM 返回格式错误的 JSON | 自动修复并返回有效计划 |
| 5 | 回退计划 | LLM 调用失败 | 返回 fallback 计划（3个默认步骤） |

**手动验证方法**:
```typescript
// 在控制台观察日志
// 关键日志: "Creating research plan for topic:", "Research plan created:"
```

### 2.2 ResearchExecutor 测试

**测试文件**: `src/main/research/researchExecutor.ts`

| # | 测试项 | 条件 | 预期结果 |
|---|--------|------|----------|
| 1 | 搜索步骤执行 | stepType: 'research' | 调用 web_search + web_fetch 工具 |
| 2 | 分析步骤执行 | stepType: 'analysis' | 调用 LLM 进行文本分析 |
| 3 | 步骤依赖 | 分析步骤依赖前序结果 | 正确传递前序步骤的 result |
| 4 | 错误处理 | 单个步骤失败 | 记录错误，继续执行后续步骤 |
| 5 | 进度回调 | 每步执行 | onProgress 被正确调用 |

**手动验证方法**:
```typescript
// 日志关键词: "Executing step", "Step completed:", "Step failed:"
```

### 2.3 ReportGenerator 测试

**测试文件**: `src/main/research/reportGenerator.ts`

| # | 测试项 | 输入 | 预期输出 |
|---|--------|------|----------|
| 1 | 学术风格报告 | style: 'academic' | 包含摘要、引言、正文、结论、参考来源 |
| 2 | 新闻风格报告 | style: 'news' | 倒金字塔结构，简洁段落 |
| 3 | 社交媒体风格 | style: 'social_media' | 列表形式，可能包含 emoji |
| 4 | 来源提取 | 研究结果包含 URL | sources 数组包含所有引用链接 |
| 5 | 空结果处理 | 无完成的步骤 | 返回最小可用报告（含错误提示） |

**手动验证方法**:
```typescript
// 日志关键词: "Generating report:", "Report generated:"
// 检查返回的 content 是否符合风格要求
```

### 2.4 DeepResearchMode 主流程测试

**测试文件**: `src/main/research/deepResearchMode.ts`

| # | 测试项 | 操作 | 预期结果 |
|---|--------|------|----------|
| 1 | 完整研究流程 | 正常输入主题 | 依次完成 planning → researching → reporting |
| 2 | 事件发送 | 研究过程中 | 正确发送 research_mode_started, research_progress, research_complete 事件 |
| 3 | 取消功能 | 研究过程中调用 cancel() | isCancelled=true，返回 "研究已被用户取消" |
| 4 | 错误处理 | 任何阶段出错 | 发送 research_error 事件，返回 success: false |

---

## 三、端到端测试用例

### 3.1 正常研究流程 (Happy Path)

**测试步骤**:
1. 启动应用
2. 点击模式切换，选择"深度研究"
3. 选择报告风格为"学术论文"
4. 输入研究主题："2024年大语言模型发展综述"
5. 点击发送

**预期结果**:
- [ ] 进度条出现，显示 Planning 阶段
- [ ] 进度更新到 Researching 阶段，显示当前步骤
- [ ] 可观察到 web_search 工具调用
- [ ] 进度更新到 Reporting 阶段
- [ ] 最终生成学术风格报告（有标题、摘要、正文、结论、来源）
- [ ] 报告显示在聊天界面中

### 3.2 不同风格测试

| 风格 | 测试主题 | 验证要点 |
|------|----------|----------|
| default | "苹果公司最新产品" | 结构清晰，语言简洁 |
| popular_science | "黑洞是什么" | 通俗易懂，有类比 |
| news | "特斯拉股价变化" | 倒金字塔结构，数据突出 |
| social_media | "春节旅游攻略" | 列表形式，简短要点 |
| strategic_investment | "新能源汽车市场" | 市场分析、风险评估、投资建议 |

### 3.3 取消操作测试

**测试步骤**:
1. 启动深度研究
2. 在 Researching 阶段（进度 30-50%）点击取消
3. 观察结果

**预期结果**:
- [ ] 进度条停止更新
- [ ] 显示"研究已被用户取消"
- [ ] 不生成报告

### 3.4 错误处理测试

| 场景 | 触发条件 | 预期行为 |
|------|----------|----------|
| 网络搜索失败 | 断网或 API 不可用 | 显示搜索失败提示，尝试继续分析 |
| LLM 调用失败 | DeepSeek API Key 无效 | 显示错误信息，研究终止 |
| 超时 | 单步执行超过 5 分钟 | 超时提示，跳过当前步骤 |

---

## 四、边界条件测试

| # | 测试项 | 输入 | 预期结果 |
|---|--------|------|----------|
| 1 | 空主题 | "" | 提示输入有效主题 |
| 2 | 超长主题 | 1000字的主题 | 正常处理或适当截断 |
| 3 | 特殊字符 | "AI & ML: <trend> \"2024\"" | 正确处理，不报错 |
| 4 | 非中文主题 | "Latest AI trends 2024" | 正常生成英文研究报告 |
| 5 | 连续请求 | 快速连续发送两个研究 | 第一个取消或排队等待 |

---

## 五、性能测试

| 指标 | 目标 | 测量方法 |
|------|------|----------|
| 计划生成时间 | < 10s | 计时 planning 阶段 |
| 单步搜索时间 | < 30s | 计时单个 research 步骤 |
| 报告生成时间 | < 20s | 计时 reporting 阶段 |
| 总研究时间 | < 3 分钟（5步计划） | 端到端计时 |
| 内存占用 | < 500MB 增量 | 监控进程内存 |

---

## 六、日志验证清单

研究过程中应能在日志中看到以下关键输出：

```
[ResearchPlanner] Creating research plan for topic: XXX
[ResearchPlanner] Research plan created: { stepsCount: X, hasResearchStep: true }
[ResearchExecutor] Executing research plan: { topic: XXX, stepsCount: X }
[ResearchExecutor] Executing step 1/X: 步骤标题
[ResearchExecutor] Step completed: { id: step_1, resultLength: XXX }
[ReportGenerator] Generating report: { topic: XXX, style: academic }
[ReportGenerator] Report generated: { title: XXX, contentLength: XXX }
[DeepResearchMode] Deep research completed: { duration: XXX, sourcesCount: X }
```

---

## 七、验收标准

### 必须通过
- [ ] 模式切换 UI 正常工作
- [ ] 6 种报告风格可选择
- [ ] 进度显示正确反映研究阶段
- [ ] 完整研究流程可执行（至少完成一次）
- [ ] 报告正确显示在聊天界面
- [ ] 取消功能正常工作
- [ ] TypeScript 类型检查通过

### 建议验证
- [ ] 不同风格报告内容符合描述
- [ ] 错误情况下的友好提示
- [ ] 研究来源正确提取和显示

---

## 八、测试记录模板

```markdown
### 测试日期: YYYY-MM-DD
### 测试人员:

#### 测试结果

| 测试项 | 结果 | 备注 |
|--------|------|------|
| 前端模式切换 | ✅/❌ | |
| 报告风格选择 | ✅/❌ | |
| 研究进度显示 | ✅/❌ | |
| 端到端研究流程 | ✅/❌ | |
| 取消功能 | ✅/❌ | |
| 错误处理 | ✅/❌ | |

#### 发现的问题

1. 问题描述...

#### 改进建议

1. 建议内容...
```
