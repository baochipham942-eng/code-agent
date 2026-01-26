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
