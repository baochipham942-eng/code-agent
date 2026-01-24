# 搜索与信息处理能力增强计划

## 背景

基于用户反馈，需要增强 Code Agent 的搜索和信息处理能力，主要包括：
1. 优化意图分类逻辑（减少不必要的询问）
2. 新增 YouTube 字幕获取能力
3. 整合 Firecrawl MCP 的搜索抓取能力
4. 提升整体搜索体验

## 已对齐的核心问题

| 问题 | 结论 |
|------|------|
| "这个/那个"指代 | 只有真正模糊的指代才询问，明确指代直接执行 |
| 商品信息抓取 | 先尝试 Firecrawl，失败再告知用户 |
| YouTube 字幕 | 使用 Supadata API（Key 已验证有效）|

## 可用资源

| 资源 | 状态 | 备注 |
|------|------|------|
| Supadata API Key | ✅ 已验证 | `sd_6d67f18e6ab981827c75e754cad993ca` |
| Firecrawl MCP | ✅ 已配置 | 搜索、抓取、地图 |
| Exa MCP | ✅ 已配置 | 代码搜索、公司研究 |
| DeepWiki MCP | ✅ 已配置 | GitHub 项目解读 |

---

## 模块拆分

### 模块 A：意图分类优化
**目标**：减少不必要的澄清询问，提升用户体验

**改动范围**：
- `src/main/research/intentClassifier.ts`

**具体任务**：
1. 优化"模糊指代"检测逻辑
   - 有明确引号内容的（如《论文名》、"关键词"）→ 直接执行
   - 有上下文指代的（前文提到的内容）→ 根据上下文理解
   - 真正无法推断的 → 才询问
2. 移除过于保守的询问规则
3. 添加"先执行后反馈"策略配置

**依赖**：无

**预估工作量**：2-3 小时

---

### 模块 B：YouTube 字幕工具
**目标**：实现 `youtube_transcript` 工具，获取 YouTube 视频字幕

**改动范围**：
- 新建 `src/main/tools/gen4/youtubeTranscript.ts`
- 修改 `src/main/tools/toolRegistry.ts`
- 修改 `src/main/tools/generationMap.ts`

**具体任务**：
1. 实现 `youtubeTranscriptTool`
   - 输入：YouTube URL 或 videoId
   - 输出：字幕文本（带时间戳）
   - 支持指定语言
2. URL 解析：支持多种 YouTube URL 格式
   - `https://www.youtube.com/watch?v=xxx`
   - `https://youtu.be/xxx`
   - `https://www.youtube.com/embed/xxx`
3. 错误处理：无字幕、API 失败等情况
4. 注册到 Gen4 工具集

**API 调用**：
```bash
GET https://api.supadata.ai/v1/transcript
  ?url={youtube_url}
  &lang={language_code}  # 可选
  &text=true             # 返回纯文本
Header: x-api-key: sd_6d67f18e6ab981827c75e754cad993ca
```

**依赖**：无

**预估工作量**：2-3 小时

---

### 模块 C：Firecrawl 搜索整合
**目标**：将 Firecrawl MCP 的能力整合到数据源路由系统

**改动范围**：
- `src/main/research/dataSourceRouter.ts`
- `src/main/research/researchExecutor.ts`
- 可能新建 `src/main/tools/gen4/firecrawlSearch.ts`

**具体任务**：
1. 在 `DataSourceType` 中添加 `firecrawl_search`、`firecrawl_scrape`
2. 配置 Firecrawl 作为搜索源的优先级和执行策略
3. 实现 Firecrawl 调用封装（通过 MCP 或直接 API）
4. 更新意图→数据源映射

**Firecrawl 能力映射**：
| Firecrawl 工具 | 用途 | 对应场景 |
|---------------|------|----------|
| `firecrawl_search` | 网络搜索 | 通用搜索、新闻 |
| `firecrawl_scrape` | 页面抓取 | 深度阅读单页 |
| `firecrawl_map` | 站点地图 | 发现站点结构 |
| `firecrawl_extract` | 结构化提取 | 商品信息、价格 |

**依赖**：无

**预估工作量**：3-4 小时

---

### 模块 D：搜索结果聚合优化
**目标**：优化多源搜索结果的聚合和去重

**改动范围**：
- `src/main/research/resultAggregator.ts`（可能新建）
- `src/main/research/progressiveLoop.ts`

**具体任务**：
1. 实现搜索结果去重（基于 URL 和内容相似度）
2. 结果排序优化（相关性、权威性、新鲜度）
3. 来源标注（标明结果来自哪个搜索源）

**依赖**：模块 C

**预估工作量**：2-3 小时

---

### 模块 E：学术搜索增强
**目标**：增强学术论文搜索能力

**改动范围**：
- 新建 `src/main/tools/gen4/academicSearch.ts`
- 修改 `src/main/research/dataSourceRouter.ts`

**具体任务**：
1. 整合 Exa 的学术搜索能力
2. 支持 arXiv、Google Scholar 等来源
3. 论文元数据提取（标题、作者、摘要、引用数）

**依赖**：无

**预估工作量**：2-3 小时

---

### 模块 F：错误处理与回退
**目标**：增强搜索失败时的回退机制

**改动范围**：
- `src/main/research/researchExecutor.ts`
- `src/main/research/progressiveLoop.ts`

**具体任务**：
1. 搜索源失败时自动切换备用源
2. 部分失败时的优雅降级
3. 用户友好的错误提示

**依赖**：模块 C、D

**预估工作量**：2 小时

---

## 多会话并行实施方案

### 会话分配策略

由于模块间存在依赖关系，建议分为 **3 个并行会话**：

```
┌─────────────────────────────────────────────────────────────┐
│                      时间线 →                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  会话 1 (独立模块)                                           │
│  ┌──────────┐  ┌──────────┐                                │
│  │ 模块 A   │  │ 模块 E   │                                │
│  │意图分类  │→ │学术搜索  │                                │
│  │ 2-3h    │  │ 2-3h    │                                  │
│  └──────────┘  └──────────┘                                │
│                                                             │
│  会话 2 (YouTube 专项)                                       │
│  ┌──────────────────────┐                                  │
│  │      模块 B          │                                  │
│  │   YouTube 字幕工具    │                                  │
│  │      2-3h           │                                   │
│  └──────────────────────┘                                  │
│                                                             │
│  会话 3 (搜索核心)                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │ 模块 C   │→ │ 模块 D   │→ │ 模块 F   │                 │
│  │Firecrawl │  │结果聚合  │  │错误回退  │                  │
│  │ 3-4h    │  │ 2-3h    │  │ 2h      │                   │
│  └──────────┘  └──────────┘  └──────────┘                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 会话 1：独立模块优化
**负责模块**：A（意图分类优化）、E（学术搜索增强）

**启动 Prompt**：
```
你是 Code Agent 项目的开发者。请完成以下任务：

1. 【模块 A】优化意图分类器
   - 文件：src/main/research/intentClassifier.ts
   - 目标：减少不必要的澄清询问
   - 具体：
     a. 有明确引号内容的请求直接执行
     b. 有上下文指代的根据上下文理解
     c. 只有真正模糊的才询问

2. 【模块 E】增强学术搜索
   - 新建：src/main/tools/gen4/academicSearch.ts
   - 整合 Exa MCP 的学术搜索能力
   - 更新 dataSourceRouter.ts 的映射

完成后运行 typecheck 验证。
```

### 会话 2：YouTube 字幕工具
**负责模块**：B（YouTube 字幕工具）

**启动 Prompt**：
```
你是 Code Agent 项目的开发者。请实现 YouTube 字幕获取工具：

【模块 B】youtube_transcript 工具
- 新建：src/main/tools/gen4/youtubeTranscript.ts
- API：Supadata (https://api.supadata.ai/v1/transcript)
- API Key：sd_6d67f18e6ab981827c75e754cad993ca

要求：
1. 支持多种 YouTube URL 格式解析
2. 支持指定语言（lang 参数）
3. 返回带时间戳的字幕文本
4. 错误处理（无字幕、API 失败）
5. 注册到 Gen4 工具集

参考 API 调用：
curl "https://api.supadata.ai/v1/transcript?url=https://youtu.be/xxx&text=true" \
  -H "x-api-key: sd_6d67f18e6ab981827c75e754cad993ca"

完成后运行 typecheck 验证。
```

### 会话 3：搜索核心能力
**负责模块**：C（Firecrawl 整合）、D（结果聚合）、F（错误回退）

**启动 Prompt**：
```
你是 Code Agent 项目的开发者。请完成搜索核心能力增强：

【模块 C】Firecrawl 搜索整合（优先）
- 修改：src/main/research/dataSourceRouter.ts
- 修改：src/main/research/researchExecutor.ts
- 将 Firecrawl MCP 整合为数据源
- 配置执行策略和优先级

【模块 D】搜索结果聚合优化
- 实现结果去重（URL + 内容相似度）
- 结果排序（相关性、权威性、新鲜度）
- 来源标注

【模块 F】错误处理与回退
- 搜索源失败时自动切换备用
- 部分失败时优雅降级
- 用户友好的错误提示

按顺序完成 C → D → F，每个模块完成后 typecheck。
```

---

## 合并与集成测试

### 合并顺序

1. **先合并会话 1 和会话 2**（无依赖冲突）
2. **再合并会话 3**（可能与会话 1 的 dataSourceRouter 修改有冲突）
3. **冲突解决**：以会话 3 的搜索核心为主，合并会话 1 的意图分类改动

### 集成测试用例

```typescript
// 1. 意图分类测试
const testCases = [
  { input: '搜索《Attention Is All You Need》论文', expectAsk: false },
  { input: '帮我搜那个东西', expectAsk: true },
  { input: '分析上面提到的那个项目', expectAsk: false }, // 有上下文
];

// 2. YouTube 字幕测试
const youtubeTests = [
  { url: 'https://youtu.be/dQw4w9WgXcQ', expectSuccess: true },
  { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expectSuccess: true },
  { url: 'invalid-url', expectError: true },
];

// 3. Firecrawl 搜索测试
const searchTests = [
  { query: 'React 18 concurrent features', sources: ['firecrawl_search', 'web_search'] },
  { query: '最新 AI 新闻', sources: ['firecrawl_search', 'news_search'] },
];
```

---

## 时间估算

| 阶段 | 预估时间 |
|------|---------|
| 会话 1（模块 A + E） | 4-6 小时 |
| 会话 2（模块 B） | 2-3 小时 |
| 会话 3（模块 C + D + F） | 7-9 小时 |
| 合并与冲突解决 | 1-2 小时 |
| 集成测试 | 2-3 小时 |
| **总计** | **16-23 小时** |

**并行执行可压缩至**：8-12 小时（3 个会话并行 + 合并测试）

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Supadata API 额度不足 | 100 次免费应足够开发测试；生产环境考虑付费 |
| Firecrawl 抓取失败 | 实现多源回退机制 |
| 代码冲突 | 明确文件分工，减少重叠修改 |
| 类型错误积累 | 每个模块完成后立即 typecheck |

---

## 验收标准

- [ ] 意图分类：明确指代的请求不再询问
- [ ] YouTube 工具：成功获取视频字幕
- [ ] Firecrawl 整合：搜索结果包含 Firecrawl 来源
- [ ] 结果聚合：无重复结果，有来源标注
- [ ] 错误回退：单源失败不影响整体搜索
- [ ] 所有 typecheck 通过
- [ ] 基本功能测试通过
