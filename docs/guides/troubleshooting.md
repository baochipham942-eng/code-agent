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

### 原生模块 NODE_MODULE_VERSION 不匹配
**问题**: 打包后启动报错 `was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 130`
**原因**: 原生模块（isolated-vm, better-sqlite3, keytar）是用系统 Node.js 编译的，而非 Electron 的 Node.js
**错误做法**:
- `electron-rebuild` 不可靠，会说 "Rebuild Complete" 但实际没重编译
- `npm rebuild` 也不行，用的是系统 Node.js

**正确做法**:
```bash
npm cache clean --force
rm -rf node_modules/isolated-vm node_modules/better-sqlite3 node_modules/keytar
npm install isolated-vm better-sqlite3 keytar \
  --build-from-source \
  --runtime=electron \
  --target=33.4.11 \
  --disturl=https://electronjs.org/headers
```

**验证方法**:
```bash
# 检查模块时间戳，应该是今天的日期
ls -la node_modules/isolated-vm/out/isolated_vm.node
ls -la node_modules/better-sqlite3/build/Release/better_sqlite3.node
ls -la node_modules/keytar/build/Release/keytar.node
```

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
