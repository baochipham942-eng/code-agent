# Code Agent 问题排查指南（错题本）

> 从 CLAUDE.md 提取的常见问题和解决方案

## Vercel 部署问题

### 部署目录混淆
**问题**: 修改了错误的 API 目录
**正确做法**: 只修改 `vercel-api/api/update.ts`

### 部署到错误项目
**问题**: 在 `vercel-api/` 目录执行 `vercel --prod`，Vercel CLI 自动创建了新项目
**原因**: Vercel CLI 会在当前目录创建 `.vercel/` 配置
**正确做法**:
1. 永远不要在 `vercel-api/` 目录执行 Vercel 命令
2. 通过 git push 触发自动部署
3. 如果 `vercel-api/.vercel/` 存在，立即删除

### Hobby 计划 12 函数限制
**问题**: 部署失败，错误 "No more than 12 Serverless Functions"
**正确做法**:
1. 将相关功能合并到一个文件，通过 `?action=xxx` 参数区分
2. 当前已合并：
   - `tools.ts` 包含 api/scrape/search 三个功能
   - `system.ts` 包含 health/init-db/migrate 三个功能
3. 当前 API 数量：10 个（预留 2 个空间）

---

## 打包问题

### 打包位置错误
**问题**: 在 worktree 中执行 `npm run dist:mac`，产物在 worktree 的 `release/` 下
**正确做法**: 切换到主仓库后再打包

### 版本号遗漏
**问题**: 修改代码后直接打包，忘记更新版本号
**正确做法**: 每次修改客户端代码必须递增 package.json 版本号

### Tauri 模式 better-sqlite3 ABI 不匹配 (2026-03-11)
**问题**: Tauri app 启动后 `Database not initialized`，ToolCache/SystemPromptCache/ContextBuilder 全部受影响
**根因**: `postinstall` 用 Electron ABI 编译 better-sqlite3，但 Tauri 通过系统 Node.js 运行 webServer.cjs，ABI 不匹配导致 `.node` 文件加载失败
**修复**:
- `scripts/rebuild-native-system.sh` — 在临时目录为系统 Node 单独编译，产物放 `dist/native/`
- `databaseService.ts` — 优先从 `dist/native/better-sqlite3` 加载，回退到 `node_modules`
- `tauri:build` / `tauri:dev` 自动执行 `rebuild-native:system`
**教训**:
- Electron 和 Tauri 的 Node.js 运行时不同，native module 必须分别编译
- 现已移除 Electron 依赖，`postinstall` 改为 `rebuild-native:system`

### Tauri 打包后 Spotlight 出现多个 Code Agent
**问题**: Spotlight 搜索出 3 个 Code Agent（Applications + bundle/macos + release/mac-arm64）
**原因**: `cargo tauri build` 在 `bundle/macos/` 生成 `.app`，旧 Electron 打包在 `release/` 也有残留
**修复**: `scripts/tauri-install.sh` — 构建后自动复制到 `/Applications/` 并删除 bundle 内的 `.app`
**教训**: macOS Spotlight 会索引所有目录的 `.app`，构建产物必须在安装后清理

### 后台 Agent 改动 SSE 协议导致 401
**问题**: 后台测试修复 agent 重构了 webServer.ts 的 SSE 事件格式，从 `{ ...event.data, sessionId }` 改为 `{ data: event.data, sessionId }`，前端解析数据结构变了导致 API 调用异常
**根因**: agent 为了防止数组型 event.data 被 spread 展开（如 `TodoItem[]` 变成 `{0: ..., 1: ...}`），但改变了前端依赖的协议格式
**修复**: 区分处理 — 数组用 `{ items: event.data, sessionId }`，对象照旧 spread
**教训（通用规则）**:
1. **后台 Agent 的改动必须逐文件 review** — agent 可能顺手"优化"不相关的代码，引入协议破坏性变更
2. **SSE/IPC 协议是前后端契约** — 改 event.data 结构等于改 API，必须前后端同步
3. **commit 前检查非预期文件** — `git diff --stat` 看到 674 行变更但只改了 3 行时，必须追问为什么

---

## 客户端启动问题

### 白屏/无响应
**问题**: 打包后应用启动白屏或无响应，通常是主进程初始化阻塞
**排查方法**:
1. 终端运行 `/Applications/Code\ Agent.app/Contents/MacOS/Code\ Agent` 查看日志
2. 检查 `initializeServices()` 中是否有阻塞操作
**常见原因**:
- MCP 服务器连接超时（远程服务不可达）
- 数据库初始化失败
- 环境变量缺失导致服务初始化卡住

### 启动慢（窗口延迟出现）
**问题**: `npm run dev` 或打包应用启动后，窗口要等很久才出现
**原因**: `initializeServices()` 中的 await 阻塞了窗口创建
**正确做法**:
- 非关键服务（MCP、LogBridge、Auth）使用 `.then()/.catch()` 异步初始化
- 只有数据库、配置等核心服务才需要 await
- 示例：`initMCPClient().then(...).catch(...)` 而非 `await initMCPClient()`

---

## 类型检查问题

### 类型错误积累
**问题**: 多个功能并行开发后合并，积累了大量类型错误
**正确做法**: 每个功能点完成后立即 `npm run typecheck`，不要等到最后一起修

### 常见类型错误模式

| 错误模式 | 原因 | 预防 |
|---------|------|------|
| `isCloud` vs `fromCloud` | 不同文件命名不一致 | 改接口时全局搜索引用 |
| Supabase 类型错误 | 缺少生成的类型定义 | 用 `as any` 临时绕过并标 TODO |
| `unknown` 转 `ReactNode` | Record<string, unknown> 取值 | 显式类型断言 |

### 验证节奏

```
写代码 → typecheck → 修复 → 功能测试 → commit
```

---

## GitHub 问题

### Secret Scanning 阻止 Push
**问题**: Git push 被 GitHub 阻止，错误 "Push cannot contain secrets"
**原因**: 测试文件中使用了符合真实 API key 格式的字符串
**正确做法**:
1. **不要在代码中硬编码**任何符合 API key 格式的字符串
2. 使用运行时字符串构建来生成测试数据：
   ```typescript
   // ❌ 错误
   const text = 'xoxb-123456789012-123456789012-abcdefghij';

   // ✅ 正确
   const buildSlackToken = (prefix: string) =>
     `${prefix}-${'1'.repeat(12)}-${'2'.repeat(12)}-${'a'.repeat(10)}`;
   ```
3. 常见被检测的格式：
   - Slack: `xoxb-*`, `xoxp-*`, `xoxa-*`
   - Stripe: `sk_live_*`, `sk_test_*`
   - GitHub: `ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`
   - AWS: `AKIA*`, `ASIA*`

---

## 模型调用问题

### 模型 429 频繁 / Provider 不可用

**问题**: 主 Provider 频繁返回 429 或瞬态错误，对话中断

**解决方案**: v0.16.42+ 已支持跨 Provider 自动降级。查看日志中的 `[ModelRouter] Fallback →` 确认降级链是否生效。

**排查步骤**：
1. 确认降级目标 Provider 的 API Key 已配置（`.env` 文件）
2. 搜索日志 `Fallback →` 确认降级是否触发
3. 如所有降级均失败，检查各 Provider 的 API 额度

**降级链配置**: `src/shared/constants.ts` 的 `PROVIDER_FALLBACK_CHAIN`

---

### 视觉模型调用失败
**问题**: 调用视觉模型时反复出错（模型名错误、参数格式不支持等）
**根本原因**: `ModelInfo` 类型缺少关键细节：
- 图片输入格式支持（base64 vs URL）
- 各参数的具体限制（如 glm-4v-flash 的 max_tokens 只有 1024）
- 模型间的能力差异（glm-4v-flash 不支持 base64）

**当前临时方案**: 在工具代码中硬编码模型选择

**相关文件**:
- `src/shared/types/model.ts` - ModelInfo 类型定义
- `src/main/model/modelRouter.ts` - 模型配置
- `src/main/tools/network/imageAnnotate.ts` - 图片标注工具
- `src/main/tools/network/imageAnalyze.ts` - 图片分析工具

---

## 调试技巧

### 本地数据库位置

```
~/Library/Application Support/code-agent/code-agent.db
```

### 查询数据库

```bash
# 查看最近 10 条消息
sqlite3 "~/Library/Application Support/code-agent/code-agent.db" \
  "SELECT role, substr(content, 1, 200), datetime(timestamp/1000, 'unixepoch', 'localtime') \
   FROM messages ORDER BY timestamp DESC LIMIT 10;"

# 查看最新一条 AI 回复
sqlite3 "~/Library/Application Support/code-agent/code-agent.db" \
  "SELECT content FROM messages WHERE role='assistant' \
   AND timestamp = (SELECT MAX(timestamp) FROM messages WHERE role='assistant');"
```

### 数据库表结构

| 表名 | 用途 |
|------|------|
| `sessions` | 会话记录 |
| `messages` | 消息历史 |
| `tool_executions` | 工具执行记录 |
| `todos` | 任务清单 |
| `project_knowledge` | 项目知识库 |
| `user_preferences` | 用户设置 |
| `audit_log` | 审计日志 |
| `file_checkpoints` | 文件检查点 (v0.16.11+) |

---

## v0.16.11+ 新增问题

### MCP 重连 UI 状态不同步
**问题**: MCP 服务器重连后，UI 状态未更新
**原因**: 重连事件未正确传播到前端
**解决**: 确保 `mcp:reconnected` 事件触发 UI 刷新

### DAG 面板无限循环
**问题**: DAG 可视化组件导致页面卡死
**原因**: `useDAGLayout` 中默认参数触发无限重渲染
**解决**: 使用 `useMemo` 缓存默认参数对象

### 评测数据库列名不匹配
**问题**: 会话评测功能查询失败
**原因**: 代码中的列名与数据库 schema 不一致
**解决**: 统一使用 snake_case 列名

### 智谱推理模型响应格式
**问题**: `glm-4.7` 推理模型返回 `reasoning_content` 字段未处理
**解决**: 在响应解析中添加对 `reasoning_content` 的支持

---

## 性能优化经验

### 首次响应延迟优化 (~500ms)
**问题**: 启动后首次对话响应慢
**优化**:
1. 异步初始化非关键服务 (MCP, LogBridge)
2. 使用 Vite 代码分割减少初始加载
3. 结构化日志替代 `console.log`

### Token 消耗优化
**问题**: 长会话 token 消耗过快
**优化**:
1. 消息摘要压缩历史
2. 工具结果截断
3. 系统提示精简

### Observation Masking 排查

**Q: Agent 仍然重复搜索已有信息？**
检查 L1 Observation Masking 是否生效：日志中应有 `[AutoCompressor] L1 Observation Masking: masked N tool outputs`。如果没有，可能 usage 未达到 60% 阈值，或 tool result 内容低于 100 tokens 未触发 mask。

### 异步 I/O 优化
**问题**: 同步 I/O 阻塞主进程
**优化**:
1. `sessionPersistence` 改为异步写入
2. `auditLogger` 使用批量写入
3. 文件操作使用 `fs/promises`

---

## v0.16.16+ 新增问题

### CLI vs Electron 原生模块编译
**问题**: CLI 和 Electron 需要不同版本的原生模块

| 运行环境 | Node ABI 版本 | 编译方式 |
|----------|---------------|----------|
| CLI (`node dist/cli/index.cjs`) | NODE_MODULE_VERSION 127 | `npm rebuild --build-from-source` |
| Electron App | NODE_MODULE_VERSION 130 | `npm run rebuild-native` |

**解决方案**: CLI 使用延迟加载，运行时检测并动态加载正确版本的原生模块。

### 第三方代理的 SSE 格式问题
**问题**: Kimi K2.5 第三方代理返回非标准 SSE 格式
```
: OPENROUTER PROCESSING

data: {"id":"gen-xxx","choices":[...]}
```
**解决方案**: 使用原生 `https` 模块处理 SSE：
1. 按 `\n` 分割 buffer
2. 忽略以 `:` 开头的注释行
3. 只处理 `data:` 开头的行
4. 处理 `[DONE]` 结束标记

相关代码：`src/main/model/providers/moonshot.ts`

### Gen8 模型不调用工具
**问题**: L4 测试大部分在 6-10 秒内失败，`tool-used: 0/7`
**原因**:
- Gen8 的 prompt 只列出了工具，没有强调必须使用工具
- 缺少工具选择决策树
- 模型倾向于直接给文本建议而不调用工具

**解决方案**:
1. 在 Gen8 Prompt 添加工具选择决策树表格
2. 明确"禁止盲编辑、先探索后执行"等原则
3. 添加正确/错误做法示例
4. 关键语句："你必须使用工具来执行任务，不能只输出文本建议！"

相关代码：`src/main/generation/prompts/base/gen8.ts`

### DAG 调度器竞态条件
**问题**: 并行任务执行时出现状态不一致
**原因**: 任务状态更新和依赖检查之间存在竞态窗口
**解决方案**:
1. 添加互斥锁保护关键状态更新
2. 使用原子操作更新任务状态
3. 添加资源泄漏检测

相关代码：`src/main/scheduler/DAGScheduler.ts`

### AgentLoop 消息转换 Bug
**问题**: 消息历史中出现空内容或格式错误
**原因**: 消息转换器未正确处理边界条件
**解决方案**: 增加空值检查和格式验证

相关代码：`src/main/agent/messageHandling/converter.ts`

### Token 优化器边界条件
**问题**: 在特定输入下 token 优化器抛出异常
**解决方案**: 添加输入验证和边界条件处理

相关代码：`src/main/context/tokenOptimizer.ts`

### Moonshot 并发子代理 Socket Hang Up
**问题**: 4 个子代理同时请求 Moonshot API 时报 `socket hang up` 错误
**原因**: Node.js 19+ 的 `https.globalAgent` 默认 `keepAlive=true`，SSE 流结束后连接被放回连接池。并发请求复用了已被服务器关闭的连接
**解决方案**:
1. 创建专用 `moonshotAgent`（`keepAlive=false`）避免连接复用
2. 添加瞬态错误自动重试（socket hang up / ECONNRESET / ECONNREFUSED）
3. 增强错误日志记录 error code

相关代码：`src/main/model/providers/moonshot.ts`

---

## v0.16.22 新增问题 (2026-02-08)

### Electron 升级天花板 = 38（isolated-vm V8 API 不兼容）
**问题**: Electron 39+ 编译 `isolated-vm` 失败
**原因**: V8 14.2（Electron 39）移除了 `v8::Object::GetIsolate()`，V8 14.4（Electron 40）还改名了 `GetPrototype()` → `GetPrototypeV2()`
**影响**: `isolated-vm` 的 `src/isolate/class_handle.h:231-233` 使用了这两个 API
**结论**:

| Electron | V8 | 编译 |
|----------|----|------|
| 38 | 14.0 | ✅ 最高兼容 |
| 39 | 14.2 | ❌ |
| 40 | 14.4 | ❌ |

**最终决策**: 升级到 Electron 38（V8 14.0, Node 22.16, Chromium 140）

### gen5.test.ts VectorStore mock 缺少 save()
**问题**: 4 个 `memory_store` 测试失败
**原因**: `store.ts:92` 调用 `await vectorStore.save()`，但测试 mock 缺少 `save` 方法，导致 TypeError 被 catch 捕获返回 `success: false`
**修复**: 在 `tests/generations/gen5.test.ts` 的 VectorStore mock 中添加 `save: vi.fn().mockResolvedValue(undefined)`

### 错误自动恢复引擎 (v0.16.22+)
**背景**: 之前错误处理只有分类（ErrorClassifier），没有自动恢复
**新增**: `RecoveryEngine` 支持 6 种错误的自动恢复

| 错误 | 恢复动作 | 说明 |
|------|---------|------|
| 429 Rate Limit | AUTO_RETRY | 指数退避重试 |
| 401 Permission | OPEN_SETTINGS | 引导用户检查 API Key |
| Context Length | AUTO_COMPACT | 自动压缩上下文 |
| Timeout | AUTO_SWITCH_PROVIDER | 切换到其他 provider |
| Connection | AUTO_RETRY | 网络错误重试 |
| Model Unavailable | AUTO_SWITCH_PROVIDER | 切换到 fallback 模型 |

相关代码：`src/main/errors/recoveryEngine.ts`

---

## v0.16.34 新增问题 (2026-02-10)

### Vitest 原生模块 SIGSEGV 崩溃 ✅ 已修复

**症状**: `npx vitest run` 部分测试文件报 `Worker exited unexpectedly`（exit code 139）

**排查过程**: 起初误判为 `isolated-vm` 导致，实际通过二分法定位到完整导入链：
```
ToolRegistry → tools → shell/bash → dynamicDescription → ModelRouter
→ configService → secureStorage → require('keytar') → SIGSEGV
```

**根因**: `keytar` 原生模块为 Electron Node.js 编译（NODE_MODULE_VERSION 130），在系统 Node.js（127）中加载导致 SIGSEGV。**SIGSEGV 是进程级崩溃，JavaScript try-catch 无法捕获。**

**误判记录**:
| 尝试 | 为什么无效 |
|------|-----------|
| `vi.mock('isolated-vm')` | 目标错误，isolated-vm 不是崩溃源 |
| `vi.mock('electron')` in setup.ts | ESM import 有效，但 `require('keytar')` 是 CJS |
| `resolve.alias` for keytar | vitest 的 alias 对 CJS `require()` 无效 |

**最终修复**（三层防御）:
1. `tests/setup.ts` 设置 `process.env.CODE_AGENT_CLI_MODE = '1'`，利用 `secureStorage.ts` 现有守卫跳过 `require('keytar')`
2. `vitest.config.ts` 的 `resolve.alias` 将 `electron` / `keytar` 映射到 mock 文件（解决 ESM import）
3. `tests/setup.ts` 的 `vi.mock()` 覆盖 6 个原生模块（electron, isolated-vm, node-pty, keytar, electron-store, better-sqlite3）

**关键教训**:
- **SIGSEGV 不可 catch**: `require()` 加载编译错误的原生模块会直接 kill 进程
- **二分法调试**: 面对模块级崩溃，逐步缩小 import 范围比猜测更高效
- **`npx tsx` 是利器**: 可以在 vitest 之外快速验证单个 import 是否崩溃
- **CJS vs ESM**: vitest 的 `vi.mock()` 和 `resolve.alias` 只对 ESM import 有效，CJS `require()` 需要通过环境变量等机制绕过
- **查看 exit code**: 139 = SIGSEGV (128 + 11)，134 = SIGABRT (128 + 6)

**相关代码**:
- `tests/setup.ts` — 全局测试 setup
- `tests/__mocks__/electron.ts` — Electron API mock
- `tests/__mocks__/keytar.ts` — Keytar mock
- `vitest.config.ts` — resolve.alias + setupFiles
- `src/main/tools/evolution/sandbox.ts` — isolated-vm 懒加载

### isolated-vm 懒加载改造

**问题**: `sandbox.ts` 在模块顶层 `require('isolated-vm')`，即使没有用到 sandbox 功能也会加载原生模块
**修复**: 改为 `getIvm()` 懒加载函数，只在 `initialize()` 实际调用时才加载
**收益**: 测试环境中不再触发 isolated-vm 加载；运行时行为不变

相关代码：`src/main/tools/evolution/sandbox.ts`

---

## 错题本 (从 CLAUDE.md 迁移)

### 2026-02-02: E2E 测试超时分析错误

**错误做法**：
- 看到测试超时 10 分钟，武断判断"模型思考太久"
- 建议增加催促机制或缩短思考时间

**正确分析方法**：
1. 先检查日志看这 10 分钟**实际产出了什么**（plan 文档？工具调用？还是 0 输出？）
2. 区分是"模型在生成内容但慢"还是"API 调用完全卡住无响应"
3. 检查 API 超时配置是否合理

**本案实际原因**：
- G07/R06 超时：zhipu provider 没有配置 timeout，API 调用卡死无响应
- M05 失败：子 agent 返回后，模型幻觉了错误路径 `/Users/codeagent/demo/...`

**经验教训**：
- 分析问题要看**具体日志和数据**，不能只看表面现象
- "超时"可能是多种原因：网络问题、API 限流、模型推理慢、配置错误

### 2026-02-02: 模型路径幻觉问题

**问题**：子 agent 返回结果后，主 agent 用错误路径读取文件

**不完整的解决方案**：只在 prompt 里声明工作目录

**更健壮的方案**（参考 [LangChain Context Engineering](https://docs.langchain.com/oss/python/langchain/context-engineering)）：
1. 子 agent 返回**绝对路径**，不依赖主 agent 拼接
2. 工具层做**路径验证**：文件存在性检查、路径前缀校验
3. 把 LLM 输出当作**不可信输入**，验证后再执行

### 2026-02-02: API 超时配置

**大厂参考**（[Claude Code Router](https://lgallardo.com/2025/08/20/claude-code-router-openrouter-beyond-anthropic/)）：
- Claude Code Router: `API_TIMEOUT_MS: 600000` (10 分钟)
- Anthropic 默认: 1 分钟（大 payload 会 504）

**建议**：
- 超时时间应**可配置**，不同任务复杂度需要不同超时
- 流式响应场景：设置首 token 超时 + 总超时
- 添加**心跳检测**：长时间无 token 返回时主动超时

### 2026-02-02: 模型名称不要乱猜

**错误做法**：
- 不查文档，凭印象猜测模型名称：`codegeex-4`、`glm-4.7-flash`、`glm-4.7`
- 结果：API 报错，浪费时间

**正确做法**：
1. 查阅 [docs/guides/model-config.md](docs/guides/model-config.md) 获取正确的模型名称
2. 查看 provider 的官方文档确认模型 ID
3. 如需切换模型，确保环境变量也同步更新

**本次正确配置**：
- 评测模型：`kimi-k2.5` (provider: `moonshot`)
- API 地址：`https://cn.haioi.net/v1`
- 环境变量：`KIMI_K25_API_KEY`

### 2026-02-02: 原生模块必须用 Electron headers 重编译 ✅ 已自动化

**症状**：
```
Error: The module was compiled against a different Node.js version
NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 130.
```

**原因**：原生模块（isolated-vm, better-sqlite3, keytar）使用系统 Node.js 编译，与 Electron 内置的 Node.js 版本不匹配。

**已实施的自动化方案**：
- `postinstall` 钩子：每次 `npm install` 后自动执行 `rebuild-native.sh`
- 脚本自动读取当前 Electron 版本，无需手动指定 `--target`
- 手动触发：`npm run rebuild-native`

### 2026-02-02: 评测维度显示问题

**问题**：
1. 维度名称显示英文（`factualAccuracy`、`economicUsage`）
2. 简单问候"你好"触发了"复杂推理"维度

**原因**：
1. `DIMENSION_NAMES` 映射缺少新增维度
2. 复杂推理检测阈值太低（任何推理关键词都触发）

**修复**：
1. 在 `sessionAnalytics.ts` 添加完整的维度枚举和映射
2. 提高复杂推理触发阈值：需要 ≥3 个匹配，且排除简单对话（≤2轮且<500字符）

### 2026-02-02: 第三方代理的 SSE 格式问题

**问题**：Kimi K2.5 第三方代理返回非标准 SSE 格式

```
: OPENROUTER PROCESSING

data: {"id":"gen-xxx","choices":[...]}
```

**错误做法**：使用 axios/electronFetch 处理流式响应（axios 不支持真正的 SSE 流式处理）

**正确做法**：使用原生 `https` 模块处理 SSE：
1. 按 `\n` 分割 buffer
2. 忽略以 `:` 开头的注释行
3. 只处理 `data:` 开头的行
4. 处理 `[DONE]` 结束标记

**相关代码**：`src/main/model/providers/moonshot.ts`

### 2026-02-02: CLI vs Electron 原生模块编译

**问题**：CLI 和 Electron 需要不同版本的原生模块

| 运行环境 | Node ABI 版本 | 编译方式 |
|----------|---------------|----------|
| CLI (node dist/cli/index.cjs) | NODE_MODULE_VERSION 127 | `npm rebuild --build-from-source` |
| Electron App | NODE_MODULE_VERSION 130 | `npm run rebuild-native` (使用 Electron headers) |

**注意**：
- `npm run rebuild-native` 是为 Electron 编译
- 如果要测试 CLI，需要先用 `npm rebuild` 为 Node.js 重编译
- 打包前必须运行 `npm run rebuild-native`

### 2026-02-02: L4 复杂任务 + Kimi K2.5 的工具调用问题 ✅ 已修复

**现象**：L4 测试大部分在 6-10 秒内失败，`tool-used: 0/7`

**根因**：
- Gen8 的 prompt 只列出了工具，没有**强调必须使用工具**
- 缺少**工具选择决策树**（什么情况用什么工具）
- 模型倾向于直接给文本建议而不调用工具

**修复方案**（已实施 commit `110c97d`）：

1. **增强 Gen8 Prompt**（`src/main/generation/prompts/base/gen8.ts`）：
   - 添加工具选择决策树表格
   - 明确"禁止盲编辑、先探索后执行"等原则
   - 添加正确/错误做法示例
   - **关键语句**："你必须使用工具来执行任务，不能只输出文本建议！"

2. **调整子代理模型配置**（`src/main/agent/agentDefinition.ts`）：
   - 简单任务（explore、bash）→ GLM-4.7-Flash（免费快）
   - 规划任务（plan、review）→ GLM-5（0ki 包年 Coding 套餐）
   - 复杂执行（coder、refactorer、debugger）→ DeepSeek V3（代码能力强）
   - 支持环境变量覆盖

**验证效果**（M04 测试）：

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 运行时间 | 9.9 秒 | 7.5 分钟 |
| agent-dispatched | ❌ | ✅ |
| tool-used | ❌ | ✅ |
| tool-count-min | ❌ | ✅ |

**结论**：过程验证 6/6 全通过，证明修复有效。结果验证部分失败是因为任务复杂需要更多时间。

### 2026-02-10: cn.haioi.net 代理并发上限 = 2 ✅ 已修复

**现象**：v4 评测全部 10 个 case 出现 TLS 断开，得分从 v3 的 71% 跌至 61%

**错误消息**：`Client network socket disconnected before secure TLS connection was established` (code=ECONNRESET)

**根因链**：
1. cn.haioi.net（Moonshot 第三方代理）在 ≥4 并发 SSE 连接时主动断开 TLS
2. `retryStrategy.ts` 只检查 `err.message` 不检查 `err.code`，TLS 错误不被识别为瞬态错误
3. Moonshot provider 无并发限流器（智谱有 `ZhipuRateLimiter` 限 3 并发）
4. `agentLoop.ts` 网络错误直接 throw 不重试

**并发安全阈值**：

| 并发数 | 表现 |
|--------|------|
| 1-2 | ✅ 稳定 |
| 3 | ⚠️ 偶发 TLS 断开 |
| 4+ | ❌ 频繁断开 |

**修复 (4 项)**：
1. `retryStrategy.ts`: 新增 `TRANSIENT_CODES` 数组 + `isTransientError` 接受 `errCode` 参数
2. `agentLoop.ts`: 网络错误在 loop 层兜底重试 1 次（2s 延迟）
3. `moonshot.ts`: 新增 `MoonshotRateLimiter`（默认 maxConcurrent=2）
4. `detector.ts`: 修复 `Ran:` 正则 `s` flag 导致 markdown 混入 bash 命令

**环境变量**：`MOONSHOT_MAX_CONCURRENT`（默认 2，可覆盖）

**Provider 并发限制汇总**：

| Provider | 限流器 | 默认并发 | 环境变量 |
|----------|--------|---------|----------|
| Moonshot (cn.haioi.net) | `MoonshotRateLimiter` | 2 | `MOONSHOT_MAX_CONCURRENT` |
| 智谱 (0ki 中转) | `ZhipuRateLimiter` | 4 | `ZHIPU_MAX_CONCURRENT` |
| DeepSeek | 无（官方 API 较稳定）| - | - |

**相关代码**：
- `src/main/model/providers/moonshot.ts` — 限流器 + keepAlive=false Agent
- `src/main/model/providers/retryStrategy.ts` — 瞬态错误检测 + 重试
- `src/main/agent/agentLoop.ts` — 网络错误兜底重试
- `src/main/agent/antiPattern/detector.ts` — force tool call 正则修复

### 2026-02-03: 模型参数格式混淆

**问题**：模型把多个参数写进单个字段
```typescript
// 错误示例
Read({ file_path: "src/app.ts offset=10 limit=50" })

// 正确格式
Read({ file_path: "src/app.ts", offset: 10, limit: 50 })
```

**原因**：工具描述缺少明确的参数格式示例

**解决方案**：
1. 工具描述增加 ✅ 正确 / ❌ 错误示例
2. 明确参数是独立字段，不能合并到路径中

**相关代码**：`src/main/generation/prompts/tools/*.ts`

### 2026-02-03: Edit 失败后的重试策略

**问题**：Edit 失败后无限重试相同参数

**错误做法**：模型反复用相同的 old_text 尝试 Edit

**正确策略**：
1. 第 1 次失败：调整 old_text（增加上下文、检查空格/换行）
2. 第 2 次失败：改用 Write 重写整个文件
3. 切换策略时通知用户原因

**相关代码**：
- `src/main/generation/prompts/tools/edit.ts`
- `src/main/agent/antiPattern/detector.ts`

### 2026-02-03: 硬编码工具调用上限导致复杂任务失败

**问题**：M06（L5 复杂度，10 步）需要 85 次工具调用，硬编码上限 80 次导致失败

**错误做法**：所有任务使用相同的工具调用上限

**正确做法**：
- 根据任务复杂度动态计算上限
- 公式：`基础上限(复杂度) + 步骤数 × 8`
- L1=20, L2=35, L3=50, L4=70, L5=100, L6=150

**相关代码**：`src/cli/commands/chat.ts` - `calculateToolCallMax()`

### 2026-02-08: Electron 40 升级失败 — isolated-vm V8 API 不兼容

**症状**: `npm install` 后 `rebuild-native` 编译 `isolated-vm` 失败

**根因**: Electron 40 使用 V8 14.4，两个 C++ API 被移除/改名：
- `v8::Object::GetIsolate()` → 已移除，替代：`v8::Isolate::GetCurrent()`
- `v8::Object::GetPrototype()` → 改名为 `GetPrototypeV2()`

**影响范围**: `isolated-vm` 的 `src/isolate/class_handle.h:231-233` 使用了这两个 API

**测试结论**:
| Electron | V8 | isolated-vm 编译 |
|----------|----|------------------|
| 33 | 13.0 | ✅ |
| 38 | 14.0 | ✅ ← 最高兼容 |
| 39 | 14.2 | ❌ GetIsolate 移除 |
| 40 | 14.4 | ❌ 同上 + GetPrototype 改名 |

**最终决策**: 升级到 Electron 38（V8 14.0, Node 22.16, Chromium 140），获得 12 个月安全补丁 + Node LTS 跳代

### 2026-02-08: gen5.test.ts VectorStore mock 缺少 save()

**症状**: 4 个 `memory_store` 测试失败，`result.success` 为 false

**根因**: `store.ts:92` 调用 `await vectorStore.save()`，但测试 mock 只有 `addKnowledge`、`search`、`indexCode`，缺少 `save` 方法

**修复**: 添加 `save: vi.fn().mockResolvedValue(undefined)` 到 VectorStore mock

### 2026-02-11: 打包后启动闪退 — 原生模块 ABI 不匹配 ✅ 已修复

**症状**: v0.16.37 安装后启动 4-6 秒即 SIGABRT，macOS 弹出 "Code Agent quit unexpectedly"

**误判过程**:
1. 崩溃报告显示 keytar.node 的 N-API cleanup hook abort → 误以为是 Keychain 问题
2. 第一次从终端运行才看到真正错误（SIGABRT 不 flush stdout，崩溃报告只有 native 栈）

**真正的错误**:
```
better_sqlite3.node was compiled against NODE_MODULE_VERSION 127.
This version of Node.js requires NODE_MODULE_VERSION 139.
```

**根因链**:
1. 打包前没执行 `npm run rebuild-native`，better-sqlite3 仍是系统 Node.js（v127）编译版本
2. Electron 38 内置 Node.js 需要 v139 → 加载 .node 文件失败
3. 数据库初始化抛出 FATAL ERROR → 主进程开始 quit
4. quit 过程中 keytar 的 N-API cleanup hook 在非 JS 上下文调用 `ThrowAsJavaScriptException()` → C++ `std::terminate` → SIGABRT

**修复**: 打包清单第 4 步显式加入 `npm run rebuild-native`

**教训**:
- `postinstall` 不可靠：`npm rebuild`（CLI 测试）、手动操作都会覆盖 Electron 编译的原生模块
- 崩溃报告的 native 栈帧可能指向"陪葬"模块而非根因 — 永远从终端运行一次看 JS 层报错
- NODE_MODULE_VERSION 速查：127=Node 22.x（系统），139=Electron 38

### 2026-03-10: CLI stdout 日志污染 + Claude provider 名称映射缺失 ✅ 已修复

**症状 1**: CLI `--json` 模式 stdout 混入大量 debug 日志，管道和程序化调用被污染

**根因**: Logger/LogCollector/bootstrap 等 40+ 处 `console.log()` 写到 stdout，违反 Unix 惯例（日志应走 stderr）

**修复**: 7 个文件中所有非结构化输出的 `console.log` → `console.error`
- logger.ts: logFn 统一用 `console.error`（所有级别）
- logCollector.ts / bootstrap.ts / logBridge.ts / mcpServer.ts / heartbeatService.ts / cronService.ts

**原则**: stdout = 结构化数据（JSON/JSONL/text reply），stderr = 日志/debug/进度

---

**症状 2**: CLI 使用 Claude 模型时 401 认证失败，即使 `.env` 中 `ANTHROPIC_API_KEY` 配置正确

**根因**: `src/cli/config.ts` 的 `getApiKey()` 中 `envKeys` 映射表只有 `anthropic: 'ANTHROPIC_API_KEY'`，但 `DEFAULT_PROVIDER = 'claude'`（不是 `'anthropic'`）。调用 `getApiKey('claude')` 时找不到映射 → 返回空字符串 → 401

**修复**: envKeys 加上 `claude: 'ANTHROPIC_API_KEY'`

**教训**:
- provider 名称 ≠ 厂商名称：code-agent 内部用 `'claude'` 不用 `'anthropic'`，新增 provider 映射时必须和 `DEFAULT_PROVIDER` / constants 对齐
- 401 不一定是 Key 无效：先 curl 直测 API 确认 Key 有效，再排查应用层是否真的把 Key 发出去了
- 三级 fallback（SecureStorage → config.json → env）中任一层返回空字符串，要确保 fall through 而不是当"找到了"
